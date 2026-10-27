// Lists the screenshots and recordings in public/ at build time, so a page whose pictures are not
// taken yet renders its placeholder in the HTML instead of a broken image.
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const publicDir = fileURLToPath(new URL('../../public/', import.meta.url))

export default {
  watch: ['../../public/img/**', '../../public/video/**'],
  load(): string[] {
    return readdirSync(publicDir, { recursive: true, encoding: 'utf8' }).map((f) =>
      f.replaceAll('\\', '/'),
    )
  },
}
