import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { migrationsFolder } from './db/migrate'
import { coaches, orders } from './db/schema'
import { cleanRichText } from './services/rich-text'
import { setup } from './test/harness'

describe('coach categories', () => {
  it('prices each lesson type by the coach category, falling back to the list price', async () => {
    const h = setup()
    const { coach, lesson, trial } = h.seed()
    const admin = await h.admin()
    const created = await h.call(
      'POST',
      '/admin/coach-categories',
      { name: '主教练', prices: [{ lessonTypeId: lesson.id, price: 36000 }] },
      admin,
    )
    expect(created.status).toBe(201)
    expect(created.json.prices).toEqual([{ lessonTypeId: lesson.id, price: 36000 }])
    const t = await h.student('a')
    const before = await h.call('GET', '/catalog', undefined, t)
    expect(before.json.coaches[0]).toMatchObject({ category: '' })
    expect(before.json.coaches[0].lessons[0].price.price).toBe(20000)

    const saved = await h.call(
      'PUT',
      `/admin/coaches/${coach.id}`,
      { name: '王教练', categoryId: created.json.id, lessonTypeIds: [lesson.id, trial.id] },
      admin,
    )
    expect(saved.json).toMatchObject({
      categoryId: created.json.id,
      lessonTypeIds: [lesson.id, trial.id],
    })
    const after = await h.call('GET', '/catalog', undefined, t)
    expect(after.json.coaches[0]).toMatchObject({ category: '主教练' })
    // The category has no trial price, so the trial stays at its list price.
    expect(
      after.json.coaches[0].lessons.map((l: { price: { price: number } }) => l.price.price),
    ).toEqual([36000, 5000])
    expect(
      after.json.lessonTypes.find((l: { id: number }) => l.id === lesson.id).fromPrice.price,
    ).toBe(36000)

    const booked = await h.call(
      'POST',
      '/bookings',
      { slotId: h.slot(coach.id).id, lessonTypeId: lesson.id },
      t,
    )
    expect(booked.status).toBe(201)
    expect(h.db.select().from(orders).get()?.amount).toBe(36000)
  })

  it('updates prices in place and refuses to delete a category in use', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const cat = h.category(coach.id, '高级教练', [{ lessonTypeId: lesson.id, price: 30000 }])
    const res = await h.call(
      'PUT',
      `/admin/coach-categories/${cat.id}`,
      {
        name: '高级教练',
        prices: [
          { lessonTypeId: lesson.id, price: 28000 },
          { lessonTypeId: lesson.id, price: 26000 },
        ],
      },
      admin,
    )
    // Duplicates collapse to the last one.
    expect(res.json.prices).toEqual([{ lessonTypeId: lesson.id, price: 26000 }])
    const t = await h.student('a')
    expect(
      (await h.call('GET', '/catalog', undefined, t)).json.coaches[0].lessons[0].price.price,
    ).toBe(26000)
    const del = await h.call('DELETE', `/admin/coach-categories/${cat.id}`, undefined, admin)
    expect(del.status).toBe(409)
    expect(del.json.error.code).toBe('category_in_use')
    h.db.update(coaches).set({ categoryId: null }).where(eq(coaches.id, coach.id)).run()
    expect(
      (await h.call('DELETE', `/admin/coach-categories/${cat.id}`, undefined, admin)).status,
    ).toBe(204)
    expect((await h.call('GET', '/admin/coach-categories', undefined, admin)).json).toEqual([])
  })

  it('rejects unknown categories and lesson types', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const badCategory = await h.call(
      'PUT',
      `/admin/coaches/${coach.id}`,
      { name: '王教练', categoryId: 999, lessonTypeIds: [lesson.id] },
      admin,
    )
    expect(badCategory.status).toBe(404)
    const badPrice = await h.call(
      'POST',
      '/admin/coach-categories',
      { name: '主教练', prices: [{ lessonTypeId: 999, price: 100 }] },
      admin,
    )
    expect(badPrice.status).toBe(404)
    expect((await h.call('GET', '/admin/coach-categories', undefined, admin)).json).toEqual([])
    const negative = await h.call(
      'POST',
      '/admin/coach-categories',
      { name: '主教练', prices: [{ lessonTypeId: lesson.id, price: -1 }] },
      admin,
    )
    expect(negative.status).toBe(400)
  })
})

describe('coach profile', () => {
  it('saves tags and a cleaned profile and shows them on the coach page', async () => {
    const h = setup()
    const { coach, lesson } = h.seed()
    const admin = await h.admin()
    const saved = await h.call(
      'PUT',
      `/admin/coaches/${coach.id}`,
      {
        name: '王教练',
        title: '前省队队员',
        tags: ['弧圈球', '弧圈球', '步法'],
        profile:
          '<h3 onclick="x()">成绩</h3><script>alert(1)</script><p style="color:red">省运会冠军</p><img src="/api/uploads/a.jpg" onerror="x()"><img src="https://evil.example/x.png">',
        lessonTypeIds: [lesson.id],
      },
      admin,
    )
    expect(saved.status).toBe(200)
    expect(saved.json.tags).toEqual(['弧圈球', '步法'])
    expect(saved.json.profile).toBe(
      '<h3>成绩</h3><p>省运会冠军</p><img src="/api/uploads/a.jpg" />',
    )

    const t = await h.student('a')
    const page = await h.call('GET', `/coaches/${coach.id}`, undefined, t)
    expect(page.json).toMatchObject({
      id: coach.id,
      name: '王教练',
      title: '前省队队员',
      tags: ['弧圈球', '步法'],
      profile: saved.json.profile,
    })
    expect(page.json.lessons).toHaveLength(1)
  })

  it('hides inactive coaches and needs a student login', async () => {
    const h = setup()
    const { coach } = h.seed()
    expect((await h.call('GET', `/coaches/${coach.id}`)).status).toBe(401)
    const t = await h.student('a')
    h.db.update(coaches).set({ active: false }).where(eq(coaches.id, coach.id)).run()
    expect((await h.call('GET', `/coaches/${coach.id}`, undefined, t)).status).toBe(404)
    expect((await h.call('GET', '/coaches/999', undefined, t)).status).toBe(404)
  })

  it('rejects too many or too long tags', async () => {
    const h = setup()
    const { coach } = h.seed()
    const admin = await h.admin()
    const long = await h.call(
      'PUT',
      `/admin/coaches/${coach.id}`,
      { name: '王教练', tags: ['一二三四五六七八九十一'] },
      admin,
    )
    expect(long.status).toBe(400)
    const many = await h.call(
      'PUT',
      `/admin/coaches/${coach.id}`,
      { name: '王教练', tags: ['1', '2', '3', '4', '5', '6', '7'] },
      admin,
    )
    expect(many.status).toBe(400)
  })
})

describe('cleanRichText', () => {
  it('keeps formatting and lists and flattens other headings', () => {
    const html =
      '<h2>经历</h2><h3>成绩</h3><p><strong>执教</strong> <em>8</em> 年</p><ul><li><p>冠军</p></li></ul><hr><blockquote><p>引用</p></blockquote>'
    expect(cleanRichText(html)).toBe(
      '经历<h3>成绩</h3><p><strong>执教</strong> <em>8</em> 年</p><ul><li><p>冠军</p></li></ul><hr /><blockquote><p>引用</p></blockquote>',
    )
  })

  it('drops links, iframes and images that are not uploads', () => {
    expect(cleanRichText('<p><a href="javascript:x()">点我</a></p><iframe src="x"></iframe>')).toBe(
      '<p>点我</p>',
    )
    expect(
      cleanRichText('<img src="//evil.example/x.png"><img src="/api/uploads/../secret">'),
    ).toBe('')
  })

  it('trims empty paragraphs at the ends', () => {
    expect(cleanRichText('<p></p><p>冠军</p><p></p><p><br></p>')).toBe('<p>冠军</p>')
    expect(cleanRichText('<p>上</p><p></p><p>下</p>')).toBe('<p>上</p><p></p><p>下</p>')
  })

  it('treats an empty editor as no profile', () => {
    expect(cleanRichText('<p></p>')).toBe('')
    expect(cleanRichText('<p> <br></p>')).toBe('')
    expect(cleanRichText('<p><img src="/api/uploads/a.png"></p>')).toBe(
      '<p><img src="/api/uploads/a.png" /></p>',
    )
  })
})

describe('0004_coach_categories', () => {
  const migrated = () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = off')
    const run = (file: string) => {
      const sql = readFileSync(join(migrationsFolder, file), 'utf8')
      for (const statement of sql.split('--> statement-breakpoint')) db.exec(statement)
    }
    run('0000_payments_and_booking_core.sql')
    run('0001_coach_mode.sql')
    return { db, finish: () => run('0004_coach_categories.sql') }
  }

  it('turns plain bios into escaped profile paragraphs', () => {
    const { db, finish } = migrated()
    const insert = db.prepare('insert into coaches (name, bio) values (?, ?)')
    insert.run('王', '擅长 <弧圈> & 步法\n执教 8 年')
    insert.run('李', '')
    finish()
    expect(db.prepare('select name, profile from coaches order by id').all()).toEqual([
      { name: '王', profile: '<p>擅长 &lt;弧圈&gt; &amp; 步法<br>执教 8 年</p>' },
      { name: '李', profile: '' },
    ])
  })

  it("keeps each coach's own prices as a category named after them", () => {
    const { db, finish } = migrated()
    db.exec(`
      insert into lesson_types (id, name, duration_minutes, price) values (1, '私教', 60, 20000), (2, '体验', 60, 5000);
      insert into coaches (id, name, sort) values (1, '王磊', 1), (2, '李静', 2);
      insert into coach_lesson_types (coach_id, lesson_type_id, price) values (1, 1, 36000), (1, 2, null), (2, 1, null);
    `)
    finish()
    expect(db.prepare('select id, category_id from coaches order by id').all()).toEqual([
      { id: 1, category_id: 1 },
      { id: 2, category_id: null },
    ])
    expect(db.prepare('select id, name, sort from coach_categories').all()).toEqual([
      { id: 1, name: '王磊', sort: 1 },
    ])
    expect(db.prepare('select * from category_prices').all()).toEqual([
      { category_id: 1, lesson_type_id: 1, price: 36000 },
    ])
    db.exec("insert into coach_categories (name) values ('主教练')")
    expect(db.prepare("select id from coach_categories where name = '主教练'").get()).toEqual({
      id: 2,
    })
  })
})
