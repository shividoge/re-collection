import { mutation, query } from './_generated/server'
import { getPerson } from './lib/data'
import { person } from './validators'

/** Who the sessions are for, e.g. { displayName: "Grandma", preferredAddress: "Mom" }. */
export const get = query({ args: {}, returns: person, handler: async (ctx) => getPerson(ctx) })

export const set = mutation({
  args: person.fields,
  returns: person,
  handler: async (ctx, args) => {
    const next = { displayName: args.displayName.trim().slice(0, 80), preferredAddress: args.preferredAddress.trim().slice(0, 40) }
    const row = await ctx.db.query('people').first()
    if (row) await ctx.db.replace(row._id, next)
    else await ctx.db.insert('people', next)
    return next
  },
})
