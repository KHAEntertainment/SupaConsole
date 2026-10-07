import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { hashPassword, createSession } from '@/lib/auth'

class RegistrationClosedError extends Error {}
class DuplicateEmailError extends Error {}

// A transient write conflict is retried so the loser's re-read count sees the
// winner. SQLite serializes writers (Prisma 6.15 issues BEGIN IMMEDIATE); a
// contended BEGIN on the native connector surfaces as P1008 (socket timeout),
// which must therefore be treated as retryable too.
function isTransientConflict(error: unknown): boolean {
  const e = error as { code?: string; message?: string }
  return (
    e?.code === 'P2034' ||
    e?.code === 'P2028' ||
    e?.code === 'P1008' ||
    /write conflict|deadlock|database is locked|SQLITE_BUSY|unable to start a transaction/i.test(
      e?.message ?? ''
    )
  )
}

// Count/closed decision and insert in one interactive transaction: two
// concurrent first-account registrations on an empty DB must not both pass.
async function createUserAtomically(
  normalizedEmail: string,
  hashedPassword: string,
  name: string | null,
  allowRegistration: boolean
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const userCount = await tx.user.count()
        if (!allowRegistration && userCount > 0) {
          throw new RegistrationClosedError('Registration is closed')
        }

        const existingUser = await tx.user.findUnique({
          where: { email: normalizedEmail },
        })
        if (existingUser) {
          throw new DuplicateEmailError('User already exists')
        }

        return tx.user.create({
          data: {
            email: normalizedEmail,
            password: hashedPassword,
            name: name || null,
          },
        })
      })
    } catch (error) {
      if (
        error instanceof RegistrationClosedError ||
        error instanceof DuplicateEmailError
      ) {
        throw error
      }
      if (!isTransientConflict(error) || attempt >= 3) {
        throw error
      }
      // Bounded backoff with jitter before the retry re-reads the count.
      await new Promise((resolve) =>
        setTimeout(resolve, 50 + Math.floor(Math.random() * 150))
      )
    }
  }
}

export async function POST(request: NextRequest) {
  try {
    const { email, password, name } = await request.json()

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Email and password are required' },
        { status: 400 }
      )
    }

    // Registration lock: check if registration is allowed
    // When ALLOW_REGISTRATION is not set, only the first user can register
    const allowRegistration = process.env.ALLOW_REGISTRATION === 'true'
    const normalizedEmail = email.toLowerCase()

    // Hash before opening the transaction: bcrypt is slow and must not hold a
    // write lock while it runs.
    const hashedPassword = await hashPassword(password)

    let user
    try {
      user = await createUserAtomically(
        normalizedEmail,
        hashedPassword,
        name || null,
        allowRegistration
      )
    } catch (error) {
      if (error instanceof RegistrationClosedError) {
        return NextResponse.json(
          { error: 'Registration is closed' },
          { status: 403 }
        )
      }
      if (error instanceof DuplicateEmailError) {
        return NextResponse.json(
          { error: 'User already exists' },
          { status: 400 }
        )
      }
      throw error
    }

    // Create session
    const token = await createSession(user.id)

    // Set cookie
    const response = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    })

    response.cookies.set('session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 24 * 60 * 60, // 24 hours
    })

    return response
  } catch (error) {
    console.error('Register error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
