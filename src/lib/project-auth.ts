import { prisma } from './db'

/**
 * Check if a project belongs to the given user.
 * Returns the project if the user owns it, null otherwise.
 * Returns 404 for both non-existent projects and projects owned by others
 * to prevent ID probing.
 */
export async function checkProjectOwnership(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, ownerId: true },
  })

  if (!project || project.ownerId !== userId) {
    return null
  }

  return project
}
