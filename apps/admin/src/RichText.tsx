import Image from '@tiptap/extension-image'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useRef, useState } from 'react'
import { Button, Divider } from 'tdesign-react'
import { uploadImage } from './api'
import { attempt } from './hooks'

/**
 * A small editor for the coach profile: headings, bold, lists, quotes and uploaded images, the
 * same set the API keeps when it cleans the HTML.
 */
export function RichText({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  const file = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        code: false,
        codeBlock: false,
        link: false,
        heading: { levels: [3] },
      }),
      Image,
    ],
    content: value,
    editorProps: {
      // Only uploaded images are kept when saving, so pasted ones from elsewhere are dropped here.
      transformPastedHTML: (html) =>
        html.replace(/<img\b[^>]*>/gi, (tag) => (/src="\/api\/uploads\//.test(tag) ? tag : '')),
    },
    onUpdate: ({ editor }) => onChange(editor.isEmpty ? '' : editor.getHTML()),
  })
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      heading: e.isActive('heading', { level: 3 }),
      bold: e.isActive('bold'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      quote: e.isActive('blockquote'),
    }),
  })

  const insertImage = async (picked: File | undefined) => {
    if (!picked) return
    setUploading(true)
    await attempt(async () => {
      const src = await uploadImage(picked)
      // The dialog may have closed while the image was uploading.
      if (!editor.isDestroyed) editor.chain().focus().setImage({ src }).run()
    })
    setUploading(false)
  }

  const tool = (label: string, on: boolean, run: () => void) => (
    <Button
      size="small"
      variant={on ? 'base' : 'text'}
      theme={on ? 'primary' : 'default'}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {label}
    </Button>
  )

  const chain = () => editor.chain().focus()
  return (
    <div className="rich-text">
      <div className="rich-text-toolbar">
        {tool('小标题', active.heading, () => chain().toggleHeading({ level: 3 }).run())}
        {tool('加粗', active.bold, () => chain().toggleBold().run())}
        {tool('列表', active.bullet, () => chain().toggleBulletList().run())}
        {tool('编号', active.ordered, () => chain().toggleOrderedList().run())}
        {tool('引用', active.quote, () => chain().toggleBlockquote().run())}
        <Divider layout="vertical" />
        <Button
          size="small"
          variant="text"
          loading={uploading}
          onClick={() => file.current?.click()}
        >
          图片
        </Button>
        <input
          ref={file}
          hidden
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={(e) => {
            void insertImage(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>
      <EditorContent editor={editor} className="rich-text-body" />
    </div>
  )
}
