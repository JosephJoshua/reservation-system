import Image from '@tiptap/extension-image'
import { NodeSelection } from '@tiptap/pm/state'
import { EditorContent, useEditor, useEditorState } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useRef } from 'react'
import { Button, Divider } from 'tdesign-react'
import { PROFILE_IMAGE, useImageUpload } from './ImageCrop'

/**
 * A small editor for the coach profile: headings, bold, lists, quotes and uploaded images, the
 * same set the API keeps when it cleans the HTML.
 */
export function RichText({ value, onChange }: { value: string; onChange: (html: string) => void }) {
  // The image being cropped again, or null when inserting a new one.
  const editing = useRef<{ pos: number; src: string } | null>(null)
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
      image:
        e.state.selection instanceof NodeSelection && e.state.selection.node.type.name === 'image'
          ? { pos: e.state.selection.from, src: String(e.state.selection.node.attrs.src) }
          : null,
    }),
  })

  const image = useImageUpload(PROFILE_IMAGE, (src) => {
    const target = editing.current
    editing.current = null
    const node = target && editor.state.doc.nodeAt(target.pos)
    if (target && node?.type.name === 'image') {
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setNodeMarkup(target.pos, undefined, { ...node.attrs, src })
          return true
        })
        .run()
      return
    }
    // With an image selected, the new one goes after it instead of replacing it.
    const { selection } = editor.state
    if (selection instanceof NodeSelection) {
      editor.chain().focus().insertContentAt(selection.to, { type: 'image', attrs: { src } }).run()
    } else editor.chain().focus().setImage({ src }).run()
  })

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
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            editing.current = null
            image.pick()
          }}
        >
          图片
        </Button>
        {active.image && (
          <Button
            size="small"
            variant="text"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const target = active.image
              if (!target) return
              editing.current = target
              image.edit(target.src)
            }}
          >
            裁剪图片
          </Button>
        )}
        {image.element}
      </div>
      <EditorContent editor={editor} className="rich-text-body" />
    </div>
  )
}
