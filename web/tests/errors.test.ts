import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'
import { errorCode, errorList, errorMessage } from '../src/data/errors'

describe('errorMessage', () => {
  it('uses the message our functions send, else a sentence for the code', () => {
    expect(errorMessage(new ConvexError({ code: 'invalid', message: 'This moment has no chapter 4.' }))).toBe('This moment has no chapter 4.')
    expect(errorMessage(new ConvexError({ code: 'no_facts' }))).toBe('Approve at least one fact before starting a visit.')
    expect(errorMessage(new ConvexError("R2 isn't configured: set R2_BUCKET."))).toBe("R2 isn't configured: set R2_BUCKET.")
  })

  it('lists every problem of an invalid upload', () => {
    const e = new ConvexError({ code: 'invalid', errors: ['depth.bin is short.', 'video.mp4 is missing.'] })
    expect(errorMessage(e)).toBe('Some files in this capture don’t match its manifest. depth.bin is short. video.mp4 is missing.')
    expect(errorList(e)).toEqual(['depth.bin is short.', 'video.mp4 is missing.'])
    expect(errorCode(e)).toBe('invalid')
  })

  it('hides Convex internals behind a calm sentence', () => {
    expect(errorMessage(new Error('[CONVEX Q(captures:get)] [Request ID: 1] Server Error Uncaught Error: boom'))).toBe('The server ran into a problem. Please try again in a moment.')
    expect(errorMessage(new Error('Couldn’t download video.mp4 (HTTP 403).'))).toBe('Couldn’t download video.mp4 (HTTP 403).')
  })
})
