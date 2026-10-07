import { prisma } from "../lib/prisma.js";
import { ConflictError, NotFoundError } from "../utils/errors.js";



export async function createTheme(data: { name: string }) {
  try {
    const theme = await prisma.theme.create({
      data: {
        name: data.name,
      },
    });

    return theme;
  } catch (error: any) {
    if (error.code === "P2002") {
      throw new ConflictError(`A theme with the name "${data.name}" already exists`);
    }
    throw error;
  }
}

export async function updateTheme(themeId: any, data: { name: string }) {
  const existing = await prisma.theme.findUnique({ where: { id: themeId } });

  if (!existing) {
    throw new NotFoundError("Theme not found");
  }

  try {
    const theme = await prisma.theme.update({
      where: { id: themeId },
      data: { name: data.name },
    });

    return theme;
  } catch (error: any) {
    if (error.code === "P2002") {
      throw new ConflictError(`A theme with the name "${data.name}" already exists`);
    }
    throw error;
  }
}


export async function deleteTheme(themeId: any) {
  const existing = await prisma.theme.findUnique({
    where: { id: themeId },
    include: { _count: { select: { comics: true } } },
  });

  if (!existing) {
    throw new NotFoundError("Theme not found");
  }

  if (existing._count.comics > 0) {
    throw new ConflictError(
      `Cannot delete theme "${existing.name}" — it still has ${existing._count.comics} comic(s) linked to it. Unlink them first.`
    );
  }

  await prisma.theme.delete({ where: { id: themeId } });
}

export async function getAllThemes() {
  const themes = await prisma.theme.findMany({
    orderBy: { name: "asc" },
  });

  return themes;
}