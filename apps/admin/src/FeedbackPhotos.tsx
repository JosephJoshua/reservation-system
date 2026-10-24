/** A 课后点评's photos as small thumbnails, each opening the full photo in a new tab. */
export function FeedbackPhotos({ photos }: { photos: string[] }) {
  if (!photos.length) return null
  return (
    <div className="feedback-photos">
      {photos.map((url, i) => (
        <a key={url} href={url} target="_blank" rel="noreferrer" title={`照片 ${i + 1}`}>
          <img src={url} alt={`照片 ${i + 1}`} loading="lazy" />
        </a>
      ))}
    </div>
  )
}
