import { useEffect, useState } from 'react'
import './App.css'

function App() {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [isDownloading, setIsDownloading] = useState(false)
  const [video, setVideo] = useState(null)
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [transcript, setTranscript] = useState(null)
  const [library, setLibrary] = useState([])
  const videoId = video?.id
  const videoStatus = video?.status

  useEffect(() => {
    fetch('/api/videos').then((response) => response.ok ? response.json() : []).then(setLibrary)
  }, [])

  useEffect(() => {
    if (!videoId || !['downloading', 'transcribing'].includes(videoStatus)) return undefined

    async function refreshVideo() {
      const response = await fetch(`/api/videos/${videoId}`)
      if (!response.ok) return
      const updatedVideo = await response.json()
      setVideo(updatedVideo)
      setLibrary((items) => items.map((item) => item.id === updatedVideo.id ? updatedVideo : item))

      if (updatedVideo.status === 'transcribed') {
        const transcriptResponse = await fetch(`/api/videos/${videoId}/transcript`)
        if (transcriptResponse.ok) setTranscript(await transcriptResponse.json())
      }
    }

    refreshVideo()
    const timer = window.setInterval(refreshVideo, 1000)
    return () => window.clearInterval(timer)
  }, [videoId, videoStatus])

  async function handleSubmit(event) {
    event.preventDefault()
    setError('')

    try {
      const parsedUrl = new URL(url)
      const hostname = parsedUrl.hostname.replace('www.', '')

      if (hostname !== 'youtube.com' && hostname !== 'youtu.be' && hostname !== 'm.youtube.com') {
        throw new Error('Enter a YouTube video URL.')
      }

      setIsDownloading(true)
      setVideo(null)
      setTranscript(null)
      const response = await fetch('/api/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      setVideo(result)
      setLibrary((items) => [result, ...items])
    } catch (submissionError) {
      setError(submissionError.message)
    } finally {
      setIsDownloading(false)
    }
  }

  async function transcribe() {
    setError('')
    setIsTranscribing(true)
    try {
      const response = await fetch(`/api/videos/${video.id}/transcript`, { method: 'POST' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error)
      setVideo(result)
      setLibrary((items) => items.map((item) => item.id === result.id ? result : item))
    } catch (transcriptionError) {
      setError(transcriptionError.message)
    } finally {
      setIsTranscribing(false)
    }
  }

  async function openVideo(selectedVideo) {
    setVideo(selectedVideo)
    setTranscript(null)
    if (selectedVideo.status !== 'transcribed') return

    const response = await fetch(`/api/videos/${selectedVideo.id}/transcript`)
    if (response.ok) setTranscript(await response.json())
  }

  async function deleteTranscript() {
    if (!window.confirm('Delete this transcript? The downloaded video will be kept.')) return
    const response = await fetch(`/api/videos/${video.id}/transcript`, { method: 'DELETE' })
    if (!response.ok) return setError((await response.json()).error)
    const updatedVideo = { ...video, status: 'ready' }
    setVideo(updatedVideo)
    setTranscript(null)
    setLibrary((items) => items.map((item) => item.id === video.id ? updatedVideo : item))
  }

  async function deleteVideo() {
    if (!window.confirm('Delete this video and its transcript? This cannot be undone.')) return
    const response = await fetch(`/api/videos/${video.id}`, { method: 'DELETE' })
    if (!response.ok) return setError((await response.json()).error)
    setLibrary((items) => items.filter((item) => item.id !== video.id))
    setVideo(null)
    setTranscript(null)
  }

  return (
    <main className="page-shell">
      <header className="site-header">
        <a className="brand" href="/">Clipnote</a>
        <span className="phase">Video workspace</span>
      </header>

      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Step 01 / Capture</p>
        <h1 id="page-title">Bring the video<br />into your workspace.</h1>
        <p className="intro">Download a local copy, then turn its speech into an accurate transcript with Whisper large-v3.</p>

        <form className="download-form" onSubmit={handleSubmit}>
          <label htmlFor="video-url">YouTube video URL</label>
          <div className="url-row">
            <input
              id="video-url"
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://www.youtube.com/watch?v=..."
              required
            />
            <button type="submit" disabled={isDownloading}>
              {isDownloading ? 'Downloading...' : 'Download video'}
            </button>
          </div>
          {error ? <p className="form-error" role="alert">{error}</p> : <p className="form-note">MP4 download. Only save videos you have permission to use.</p>}
        </form>

        {video && (
          <section className="video-card" aria-live="polite">
            <p className="eyebrow">Step 02 / Transcribe</p>
            <h2>{video.title}</h2>
            <p className="video-meta">{video.status === 'downloading' ? 'Downloading video' : `Downloaded locally · ${Math.ceil(video.sizeBytes / 1024 ** 2)} MB`}</p>
            <div className="job-progress" aria-label={`${video.status} progress`}>
              <div className="progress-track"><span style={{ width: `${video.progress}%` }} /></div>
              <span>{video.progress}% · {video.status}</span>
            </div>
            {video.status === 'transcribing' && <p className="resource-usage">CPU {video.cpuPercent.toFixed(0)}% · Memory {(video.memoryBytes / 1024 ** 3).toFixed(1)} GB</p>}
            <output className="job-output">{video.output || 'Waiting for output...'}</output>
            <button type="button" className="transcribe-button" onClick={transcribe} disabled={video.status !== 'ready' || isTranscribing || Boolean(transcript)}>
              {video.status === 'downloading' ? 'Download in progress' : video.status === 'transcribing' ? 'Transcribing with large-v3...' : transcript || video.status === 'transcribed' ? 'Transcript complete' : 'Create transcript'}
            </button>
            {video.status === 'ready' && <p className="form-note">Transcription is manual. Click Create transcript when you are ready.</p>}
            {video.status === 'transcribing' && <p className="form-note">This CPU-only machine may take longer than the video duration. Keep this tab open.</p>}
            {!['downloading', 'transcribing'].includes(video.status) && (
              <div className="delete-actions">
                {transcript && <button type="button" onClick={deleteTranscript}>Delete transcript</button>}
                <button type="button" onClick={deleteVideo}>Delete video</button>
              </div>
            )}
          </section>
        )}

        {transcript && (
          <section className="transcript-card">
            <p className="eyebrow">Transcript / {transcript.language}</p>
            <p>{transcript.text}</p>
          </section>
        )}

        <section className="library" aria-labelledby="library-title">
          <div className="library-heading">
            <p className="eyebrow">Library</p>
            <h2 id="library-title">Saved videos</h2>
          </div>
          {library.length === 0 ? <p className="empty-library">Downloaded videos and completed transcripts will appear here.</p> : (
            <div className="library-list">
              {library.map((item) => (
                <button className={`library-item ${item.id === video?.id ? 'selected' : ''}`} type="button" key={item.id} onClick={() => openVideo(item)}>
                  <span>{item.title}</span>
                  <small>{item.status === 'transcribed' ? 'Transcript ready' : item.status}</small>
                </button>
              ))}
            </div>
          )}
        </section>
      </section>

      <footer>
        <span>Local-first video notes</span>
        <span>Built for focused viewing</span>
      </footer>
    </main>
  )
}

export default App
