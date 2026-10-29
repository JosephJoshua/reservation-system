import { useEffect, useState } from 'react'
import { fetchFile } from './api'

/**
 * A 课后点评's photos as small thumbnails, each opening the full photo in a new tab. Photos of
 * feedback the student does not see (`restricted`) are only served to staff, so they are loaded
 * with the admin's sign-in; the others load like any image.
 */
export function FeedbackPhotos({
  photos,
  restricted = false,
}: {
  photos: string[]
  restricted?: boolean
}) {
  if (!photos.length) return null
  return restricted ? <StaffPhotos photos={photos} /> : <Thumbs photos={photos} />
}

function Thumbs({ photos, local }: { photos: string[]; local?: Record<string, string | null> }) {
  return (
    <div className="feedback-photos">
      {photos.map((url, i) => {
        const src = local ? local[url] : url
        const label = `照片 ${i + 1}`
        if (!src) {
          return (
            <span
              key={url}
              className="feedback-photo-empty"
              title={src === null ? `${label}无法加载` : label}
            />
          )
        }
        return (
          <a key={url} href={src} target="_blank" rel="noreferrer" title={label}>
            <img src={src} alt={label} loading="lazy" />
          </a>
        )
      })}
    </div>
  )
}

function StaffPhotos({ photos }: { photos: string[] }) {
  const key = photos.join('\n')
  // Kept with the list they were loaded for, so a changed list never shows revoked ones.
  const [loaded, setLoaded] = useState<{ key: string; local: Record<string, string | null> }>({
    key: '',
    local: {},
  })
  useEffect(() => {
    let live = true
    const made: string[] = []
    setLoaded({ key, local: {} })
    for (const url of key.split('\n')) {
      const name = url.replace(/^\/api\/uploads\//, '')
      fetchFile(`/admin/feedback-photos/${encodeURIComponent(name)}`).then(
        ({ blob }) => {
          if (!live) return
          const local = URL.createObjectURL(blob)
          made.push(local)
          setLoaded((m) => (m.key === key ? { key, local: { ...m.local, [url]: local } } : m))
        },
        () => {
          if (live) {
            setLoaded((m) => (m.key === key ? { key, local: { ...m.local, [url]: null } } : m))
          }
        },
      )
    }
    return () => {
      live = false
      for (const local of made) URL.revokeObjectURL(local)
    }
  }, [key])
  return <Thumbs photos={photos} local={loaded.key === key ? loaded.local : {}} />
}
