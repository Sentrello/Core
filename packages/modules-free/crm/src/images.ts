/**
 * A picture on a contact or a company.
 *
 * Phones produce four-megapixel photographs and people upload them as avatars.
 * Storing that is a slow page for everybody forever, so every image is
 * re-encoded on the way in: rotated upright, scaled to fit, written as WebP.
 * What arrives is never what is stored.
 *
 * That re-encoding is also the security boundary, and the reason it happens
 * even for a file that is already a small WebP. A `.png` that is really HTML,
 * an SVG carrying a script, a JPEG with a payload after the end marker — none
 * of them survive being decoded to pixels and encoded again. The bytes we
 * serve are bytes this process produced.
 */
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import type { ModuleContext } from "@sentrello/module-sdk";
import sharp from "sharp";

/** Beside the note attachments, under the data directory. */
const imagesDir = () =>
  join(resolve(process.env.SENTRELLO_DATA_DIR ?? "/data"), "crm-images");

/**
 * Five megabytes in, one small WebP out.
 *
 * The cap is on what may be *uploaded*, because the work of decoding happens
 * before any resizing can. A phone photo is two to five megabytes; anything
 * far beyond that is somebody uploading a document by mistake.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * 512 on the long edge.
 *
 * Twice the largest size either of these is ever drawn at, so it stays sharp on
 * a retina screen and nowhere near the size of the original. Aspect ratio is
 * kept — a squashed logo looks worse than a small one — and a picture already
 * smaller than this is left at its own size rather than blown up.
 */
const MAX_EDGE = 512;

/**
 * Raster formats only, and deliberately not SVG.
 *
 * SVG is a document format that can carry scripts and external references, and
 * rasterising one means handing an untrusted document to a parser with a
 * history of surprises. Nobody uploads a vector as their avatar.
 */
const ACCEPTED = new Set(["jpeg", "jpg", "png", "webp", "gif", "avif", "heif"]);

export interface ProcessedImage {
  bytes: Uint8Array;
  width: number;
  height: number;
}

/**
 * Decode, straighten, shrink, re-encode.
 *
 * Exported so it can be tested without a database or a session: this is where
 * a bad file has to be rejected, and it is worth being able to prove that on
 * its own.
 */
export async function processImage(input: Uint8Array): Promise<ProcessedImage> {
  if (input.byteLength === 0) throw new RangeError("that file is empty");
  if (input.byteLength > MAX_IMAGE_BYTES) {
    throw new RangeError(
      `images must be under ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)}MB`,
    );
  }

  let format: string | undefined;
  try {
    format = (await sharp(input).metadata()).format;
  } catch {
    throw new RangeError("that does not look like an image");
  }
  if (!format || !ACCEPTED.has(format)) {
    throw new RangeError(
      `${format ?? "that file"} cannot be used as a picture here`,
    );
  }

  const output = await sharp(input)
    // Phone cameras record orientation in EXIF rather than in the pixels. Skip
    // this and every photograph taken sideways is stored sideways.
    .rotate()
    .resize(MAX_EDGE, MAX_EDGE, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer({ resolveWithObject: true });

  return {
    bytes: new Uint8Array(output.data),
    width: output.info.width,
    height: output.info.height,
  };
}

/**
 * Reading the stored name off either row.
 *
 * A contact and a company are different shapes, and TypeScript will not index
 * one union with the other's key. Naming both columns here is more honest than
 * casting the row away, and it fails loudly if either is ever renamed.
 */
type Pictured = { avatarPath?: string | null; logoPath?: string | null };
const storedName = (row: Pictured, column: "avatarPath" | "logoPath") =>
  row[column] ?? null;

/** The two things that can carry a picture, and the column each keeps it in. */
const SUBJECTS = {
  contacts: { table: schema.contacts, column: "avatarPath" as const },
  companies: { table: schema.companies, column: "logoPath" as const },
};
type Subject = keyof typeof SUBJECTS;

export function registerCrmImages(ctx: ModuleContext) {
  for (const subject of Object.keys(SUBJECTS) as Subject[]) {
    const { table, column } = SUBJECTS[subject];

    ctx.app.post(
      `/api/crm/${subject}/:id/image`,
      requireSession(),
      requirePermission({ crm: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const id = c.req.param("id");

        const [row] = await db
          .select()
          .from(table)
          .where(and(eq(table.id, id), eq(table.organizationId, orgId)))
          .limit(1);
        if (!row) return c.json({ error: "not found" }, 404);

        const form = await c.req.formData().catch(() => null);
        const file = form?.get("image");
        if (!(file instanceof File)) {
          return c.json({ error: "no image was sent" }, 400);
        }

        let processed: ProcessedImage;
        try {
          processed = await processImage(
            new Uint8Array(await file.arrayBuffer()),
          );
        } catch (err) {
          if (err instanceof RangeError) {
            return c.json({ error: err.message }, 400);
          }
          throw err;
        }

        // Generated, never the uploaded name: nothing a caller sends should
        // ever decide where a file lands.
        const name = `${crypto.randomUUID()}.webp`;
        await mkdir(imagesDir(), { recursive: true });
        await writeFile(join(imagesDir(), name), processed.bytes);

        const previous = storedName(row, column);
        await db
          .update(table)
          .set({ [column]: name })
          .where(and(eq(table.id, id), eq(table.organizationId, orgId)));

        // The one it replaced is now unreachable. Left behind it would be a
        // disk that only ever grows.
        if (previous) {
          await unlink(join(imagesDir(), previous)).catch(() => {});
        }

        return c.json({
          path: name,
          width: processed.width,
          height: processed.height,
          bytes: processed.bytes.byteLength,
        });
      },
    );

    ctx.app.delete(
      `/api/crm/${subject}/:id/image`,
      requireSession(),
      requirePermission({ crm: ["update"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const id = c.req.param("id");

        const [row] = await db
          .select()
          .from(table)
          .where(and(eq(table.id, id), eq(table.organizationId, orgId)))
          .limit(1);
        if (!row) return c.json({ error: "not found" }, 404);
        const existing = storedName(row, column);
        if (!existing) return c.json({ error: "there is no picture" }, 404);

        await db
          .update(table)
          .set({ [column]: null })
          .where(and(eq(table.id, id), eq(table.organizationId, orgId)));
        await unlink(join(imagesDir(), existing)).catch(() => {});
        return c.json({ removed: true });
      },
    );

    /**
     * Serving one back.
     *
     * Behind the same permission as reading the record: a picture of somebody's
     * customer is customer data. The filename is a UUID this process generated
     * and is checked against the record rather than trusted from the URL, so
     * there is nothing to traverse with.
     */
    ctx.app.get(
      `/api/crm/${subject}/:id/image`,
      requireSession(),
      requirePermission({ crm: ["read"] }),
      async (c) => {
        const orgId = activeOrganizationId(c.get("session"));
        const [row] = await db
          .select()
          .from(table)
          .where(
            and(
              eq(table.id, c.req.param("id")),
              eq(table.organizationId, orgId),
            ),
          )
          .limit(1);
        const stored = row ? storedName(row, column) : null;
        if (!stored) return c.json({ error: "not found" }, 404);

        const file = Bun.file(join(imagesDir(), stored));
        if (!(await file.exists())) return c.json({ error: "not found" }, 404);

        return new Response(file.stream(), {
          headers: {
            "content-type": "image/webp",
            // The name changes whenever the picture does, so the old one can
            // be cached hard and a new one is never stale.
            "cache-control": "private, max-age=31536000, immutable",
            "content-security-policy": "default-src 'none'",
            "x-content-type-options": "nosniff",
          },
        });
      },
    );
  }
}
