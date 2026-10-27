import { mkdir, readFile, rm, statfs } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import readline from 'node:readline'
import express from 'express'

const root = path.dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.DATA_DIR || path.join(root, 'data')
const videosDir = path.join(dataDir, 'videos')
const transcriptsDir = path.join(dataDir, 'transcripts')
const legacyMetadataPath = path.join(dataDir, 'videos.json')
const databasePath = path.join(dataDir, 'clipnote.db')
const port = process.env.PORT || 3001
const reserveBytes = 5 * 1024 ** 3
const runCommand = promisify(execFile)
mkdirSync(dataDir, { recursive: true })
const db = new DatabaseSync(databasePath)
let isTranscribing = false

const app = express()
app.use(express.json())

function videoFromRow(row) {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    durationSeconds: row.duration_seconds,
    sizeBytes: row.size_bytes,
    status: row.status,
    createdAt: row.created_at,
    filename: row.filename,
    metadata: JSON.parse(row.metadata_json),
    progress: row.progress,
    output: row.output,
    cpuPercent: row.cpu_percent,
    memoryBytes: row.memory_bytes,
  }
}

function getVideo(id) {
  return videoFromRow(db.prepare('SELECT * FROM videos WHERE id = ?').get(id))
}

function listVideos() {
  return db.prepare('SELECT * FROM videos ORDER BY created_at DESC').all().map(videoFromRow)
}

function updateVideoStatus(id, status) {
  db.prepare('UPDATE videos SET status = ? WHERE id = ?').run(status, id)
}

function updateProgress(id, progress) {
  db.prepare('UPDATE videos SET progress = ? WHERE id = ?').run(progress, id)
}

function appendOutput(id, chunk) {
  const row = db.prepare('SELECT output FROM videos WHERE id = ?').get(id)
  const output = `${row.output}${chunk}`.slice(-12000)
  db.prepare('UPDATE videos SET output = ? WHERE id = ?').run(output, id)
}

async function sampleProcessUsage(id, pid) {
  try {
    const { stdout } = await runCommand('ps', ['-p', String(pid), '-o', '%cpu=', '-o', 'rss='])
    const [cpu, rss] = stdout.trim().split(/\s+/)
    db.prepare('UPDATE videos SET cpu_percent = ?, memory_bytes = ? WHERE id = ?').run(Number(cpu), Number(rss) * 1024, id)
  } catch {
    // The worker may exit between the timer tick and the sample.
  }
}

function monitorProcess(id, pid) {
  const timer = setInterval(() => void sampleProcessUsage(id, pid), 1000)
  void sampleProcessUsage(id, pid)
  return () => clearInterval(timer)
}

function storeTranscript(videoId, transcript) {
  db.prepare(`
    INSERT OR REPLACE INTO transcripts (video_id, language, language_probability, model, content_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(videoId, transcript.language, transcript.languageProbability, 'large-v3', JSON.stringify(transcript), new Date().toISOString())
}

async function availableBytes() {
  const stats = await statfs(dataDir)
  return stats.bavail * stats.bsize
}

async function getVideoInfo(url) {
  const { stdout } = await runCommand('yt-dlp', ['--dump-single-json', '--no-playlist', '--no-warnings', url], { maxBuffer: 50 * 1024 ** 2 })
  return JSON.parse(stdout)
}

function downloadVideo(url, id) {
  const template = path.join(videosDir, `${id}.%(ext)s`)
  const args = ['--no-playlist', '--no-warnings', '--newline', '--format', 'bv*+ba/b', '--merge-output-format', 'mp4', '--output', template, url]
  return new Promise((resolve, reject) => {
    const process = spawn('yt-dlp', args)
    const onOutput = (data) => {
      const text = data.toString()
      appendOutput(id, text)
      const match = text.match(/(\d+(?:\.\d+)?)%/)
      if (match) updateProgress(id, Math.min(99, Math.floor(Number(match[1]))))
    }
    process.stdout.on('data', onOutput)
    process.stderr.on('data', onOutput)
    process.on('error', reject)
    process.on('close', (code) => code === 0 ? resolve() : reject(new Error(`yt-dlp exited with ${code}`)))
  })
}

function estimatedSize(info) {
  if (info.filesize) return Number(info.filesize)
  if (info.filesize_approx) return Number(info.filesize_approx)
  return Math.ceil((info.duration || 0) * 2_500_000 / 8)
}

function sendError(res, status, error) {
  return res.status(status).json({ error })
}

app.get('/api/videos', (_req, res) => res.json(listVideos()))
app.get('/api/videos/:id', (req, res) => {
  const video = getVideo(req.params.id)
  if (!video) return sendError(res, 404, 'Video not found.')
  res.json(video)
})

app.post('/api/videos', async (req, res) => {
  const { url } = req.body
  if (typeof url !== 'string' || !/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(url)) return sendError(res, 400, 'A valid YouTube video URL is required.')

  try {
    const info = await getVideoInfo(url)
    const durationSeconds = Number(info.duration)
    const sizeBytes = estimatedSize(info)
    const freeBytes = await availableBytes()
    if (!sizeBytes) return sendError(res, 422, 'Unable to estimate this video size. Try another video.')
    if (sizeBytes > freeBytes - reserveBytes) return sendError(res, 507, `This video needs about ${Math.ceil(sizeBytes / 1024 ** 2)} MB, but there is not enough safe disk space.`)

    const id = crypto.randomUUID()
    const filename = `${id}.mp4`
    const metadata = {
      sourceUrl: info.webpage_url || url,
      providerId: info.id,
      uploader: info.uploader,
      channel: info.channel,
      uploadDate: info.upload_date,
      description: info.description,
      thumbnail: info.thumbnail,
      categories: info.categories,
      tags: info.tags,
    }
    db.prepare(`
      INSERT INTO videos (id, title, duration_seconds, size_bytes, status, created_at, filename, metadata_json, progress, output)
      VALUES (?, ?, ?, ?, 'downloading', ?, ?, ?, 0, 'Queued for download\n')
    `).run(id, info.title, durationSeconds, sizeBytes, new Date().toISOString(), filename, JSON.stringify(metadata))
    downloadVideo(url, id)
      .then(() => {
        updateProgress(id, 100)
        updateVideoStatus(id, 'ready')
        appendOutput(id, 'Download complete.\n')
      })
      .catch((error) => {
        console.error('Download failed:', error.message)
        updateVideoStatus(id, 'failed')
        appendOutput(id, `Download failed: ${error.message}\n`)
      })
    res.status(202).json(getVideo(id))
  } catch (error) {
    console.error('Download failed:', error.message)
    sendError(res, 502, 'Unable to download that YouTube video.')
  }
})

app.get('/api/videos/:id/transcript', (req, res) => {
  const transcript = db.prepare('SELECT content_json FROM transcripts WHERE video_id = ?').get(req.params.id)
  if (!transcript) return sendError(res, 404, 'Transcript not found.')
  res.json(JSON.parse(transcript.content_json))
})

app.delete('/api/videos/:id/transcript', (req, res) => {
  const result = db.prepare('DELETE FROM transcripts WHERE video_id = ?').run(req.params.id)
  if (result.changes === 0) return sendError(res, 404, 'Transcript not found.')
  updateVideoStatus(req.params.id, 'ready')
  res.status(204).end()
})

app.delete('/api/videos/:id', async (req, res) => {
  const video = getVideo(req.params.id)
  if (!video) return sendError(res, 404, 'Video not found.')
  if (['downloading', 'transcribing'].includes(video.status)) return sendError(res, 409, 'Wait for the active job to finish before deleting this video.')

  await rm(path.join(videosDir, video.filename), { force: true })
  db.prepare('DELETE FROM videos WHERE id = ?').run(video.id)
  res.status(204).end()
})

app.post('/api/videos/:id/transcript', async (req, res) => {
  const video = getVideo(req.params.id)
  if (!video || video.status !== 'ready') return sendError(res, 404, 'A downloaded video is required.')
  if (isTranscribing) return sendError(res, 409, 'Another transcription is already running. Try again when it finishes.')

  isTranscribing = true
  updateVideoStatus(video.id, 'transcribing')
  updateProgress(video.id, 0)
  appendOutput(video.id, 'Starting large-v3 transcription.\n')
  res.status(202).json(getVideo(video.id))

  const transcriptPath = path.join(transcriptsDir, `${video.id}.json`)
  try {
    await new Promise((resolve, reject) => {
      const process = spawn('python3', [path.join(root, 'transcribe.py'), path.join(videosDir, video.filename), transcriptPath, String(video.durationSeconds)])
      const stopMonitoring = monitorProcess(video.id, process.pid)
      const stdout = readline.createInterface({ input: process.stdout })
      stdout.on('line', (line) => {
        try {
          const event = JSON.parse(line)
          if (event.type === 'progress') updateProgress(video.id, event.progress)
          else if (event.type === 'log') appendOutput(video.id, `${event.message}\n`)
        } catch {
          appendOutput(video.id, `${line}\n`)
        }
      })
      process.stderr.on('data', (data) => appendOutput(video.id, data.toString()))
      process.on('error', reject)
      process.on('close', (code) => {
        stopMonitoring()
        if (code === 0) resolve()
        else reject(new Error(`Transcriber exited with ${code}`))
      })
    })
    const transcript = JSON.parse(await readFile(transcriptPath, 'utf8'))
    storeTranscript(video.id, transcript)
    await rm(transcriptPath)
    updateProgress(video.id, 100)
    updateVideoStatus(video.id, 'transcribed')
    appendOutput(video.id, 'Transcription complete.\n')
  } catch (error) {
    console.error('Transcription failed:', error.message)
    updateVideoStatus(video.id, 'ready')
    appendOutput(video.id, `Transcription failed: ${error.message}\n`)
  } finally {
    isTranscribing = false
  }
})

app.use(express.static(path.join(root, 'dist')))
app.get('*splat', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')))

async function start() {
  await mkdir(videosDir, { recursive: true })
  await mkdir(transcriptsDir, { recursive: true })
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      duration_seconds REAL NOT NULL,
      size_bytes INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      filename TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0,
      output TEXT NOT NULL DEFAULT '',
      cpu_percent REAL NOT NULL DEFAULT 0,
      memory_bytes INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS transcripts (
      video_id TEXT PRIMARY KEY REFERENCES videos(id) ON DELETE CASCADE,
      language TEXT NOT NULL,
      language_probability REAL NOT NULL,
      model TEXT NOT NULL,
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    UPDATE videos SET status = 'ready' WHERE status = 'transcribing';
    UPDATE videos SET progress = 100 WHERE status IN ('ready', 'transcribed') AND progress = 0;
  `)

  const columns = db.prepare('PRAGMA table_info(videos)').all().map((column) => column.name)
  if (!columns.includes('progress')) db.exec('ALTER TABLE videos ADD COLUMN progress INTEGER NOT NULL DEFAULT 0')
  if (!columns.includes('output')) db.exec("ALTER TABLE videos ADD COLUMN output TEXT NOT NULL DEFAULT ''")
  if (!columns.includes('cpu_percent')) db.exec('ALTER TABLE videos ADD COLUMN cpu_percent REAL NOT NULL DEFAULT 0')
  if (!columns.includes('memory_bytes')) db.exec('ALTER TABLE videos ADD COLUMN memory_bytes INTEGER NOT NULL DEFAULT 0')

  try {
    const legacyVideos = JSON.parse(await readFile(legacyMetadataPath, 'utf8'))
    const count = db.prepare('SELECT COUNT(*) AS count FROM videos').get().count
    if (count === 0) {
      const insert = db.prepare('INSERT INTO videos VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      for (const video of legacyVideos) insert.run(video.id, video.title, video.durationSeconds, video.sizeBytes, video.status, video.createdAt, video.filename, '{}')
    }
  } catch {
    // No legacy registry is present on fresh installations.
  }

  app.listen(port, () => console.log(`Clipnote listening on http://localhost:${port}`))
}

start()
