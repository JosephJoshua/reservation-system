/** Opens the photo at `index` full screen, with the others to swipe through. */
export function previewPhotos(urls: string[], index: unknown): void {
  const current = urls[Number(index)]
  if (current) wx.previewImage({ current, urls })
}
