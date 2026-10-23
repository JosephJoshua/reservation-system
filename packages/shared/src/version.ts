/**
 * A short fingerprint of a record as the API sends it. An editor sends the fingerprint of what it
 * loaded with its save, so a save made on top of someone else's change is refused instead of
 * silently undoing it. Both sides hash the same JSON text, so it must be the API's own output.
 */
export function versionOf(value: unknown): string {
  // FNV-1a, 32 bit. Collisions only matter between two edits of one record, so this is plenty.
  let hash = 0x811c9dc5
  const text = JSON.stringify(value)
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
