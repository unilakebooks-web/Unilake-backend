import { PrismaClient } from '../generated/prisma/client.js'
import { PrismaNeon } from '@prisma/adapter-neon'
import { config } from '../config/env.js'

const adapter = new PrismaNeon({
  connectionString: config.DATABASE_URL!,
})

export const prisma = new PrismaClient({ adapter })