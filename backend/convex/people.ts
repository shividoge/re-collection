import { mutation, query } from './_generated/server'
import { notImplemented } from './lib_stub'
import { person } from './validators'

export const get = query({ args: {}, returns: person, handler: async () => notImplemented('people.get') })

export const set = mutation({ args: person.fields, returns: person, handler: async () => notImplemented('people.set') })
