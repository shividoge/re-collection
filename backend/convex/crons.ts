import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'

const crons = cronJobs()

// Jobs whose worker stopped heartbeating go back to the queue (three strikes → failed).
crons.interval('re-queue expired job leases', { seconds: 30 }, internal.jobsCron.reap, {})
// Museum rooms nobody has used for three hours, and screens that left.
crons.interval('sweep museum rooms', { minutes: 10 }, internal.museum.sweep, {})

// Uploads started but abandoned for 7 days (removed like captures.remove does).
crons.daily('remove abandoned uploads', { hourUTC: 11, minuteUTC: 0 }, internal.captures.sweepAbandoned, {})

export default crons
