import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { db, schema } from "@sentrello/db";
import type { ModuleContext } from "@sentrello/module-sdk";
import { and, eq } from "drizzle-orm";

/**
 * Files on notes.
 *
 * A quote, a photo of the damp patch, a signed job sheet. Kept on disk under
 * the data directory and recorded on the note as a path — not as bytes in a
 * column, which would bloat every backup and every query that touches the row.
 *
 * Three things here are security, not housekeeping:
 *
 *  - the stored filename is generated, never the one that was uploaded, so
 *    nothing a caller sends can climb out of the directory;
 *  - files come back as downloads with a neutral content type, so an uploaded
 *    .html or .svg cannot execute against this origin as the signed-in user;
 *  - reading one requires permission on the note it hangs from, since the
 *    files themselves have no owner of their own.
 */

/** Where they live. Beside the licence token and the update request files. */
const attachmentsDir = () =>
  join(resolve(process.env.SENTRELLO_DATA_DIR ?? "/data"), "attachments");

/**
 * Ten megabytes.
 *
 * Large enough for a scanned quote or a phone photo, small enough that a
 * business cannot fill its own disk by accident. nginx refuses larger bodies
 * before this is ever reached, so the two need to stay in step.
 */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * The extension, if it is one we are prepared to write.
 *
 * Not a security control on its own — the content type on the way out is what
 * makes an uploaded file harmless. This only keeps the directory tidy and
 * stops a filename's own punctuation reaching the filesystem.
 */
export function safeExtension(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

/** Shown to people; never used as a path. */
export function displayFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "file";
  return base.slice(0, 120) || "file";
}

export function registerAttachments(ctx: ModuleContext) {
  ctx.app.post(
    "/api/notes/:id/attachments",
    requireSession(),
    requirePermission({ crm: ["update"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));
      const noteId = c.req.param("id");

      const [note] = await db
        .select()
        .from(schema.notes)
        .where(
          and(
            eq(schema.notes.id, noteId),
            eq(schema.notes.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!note) return c.json({ error: "not found" }, 404);

      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) {
        return c.json({ error: "a file is required" }, 400);
      }
      if (file.size === 0) return c.json({ error: "that file is empty" }, 400);
      if (file.size > MAX_ATTACHMENT_BYTES) {
        return c.json({ error: "that file is too large (10MB limit)" }, 413);
      }

      // The name on disk is ours. Nothing the caller sent is used to build it,
      // so `../../etc/passwd` and a filename full of quotes are both just a
      // display string.
      const stored = `${crypto.randomUUID()}${safeExtension(file.name)}`;
      const dir = join(attachmentsDir(), orgId);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, stored),
        Buffer.from(await file.arrayBuffer()),
        {
          mode: 0o600,
        },
      );

      const attachment = {
        name: displayFilename(file.name),
        path: `${orgId}/${stored}`,
        size: file.size,
        type: file.type || "application/octet-stream",
      };
      const [updated] = await db
        .update(schema.notes)
        .set({ attachments: [...(note.attachments ?? []), attachment] })
        .where(eq(schema.notes.id, noteId))
        .returning();

      return c.json({ note: updated }, 201);
    },
  );

  ctx.app.get(
    "/api/notes/:id/attachments/:index",
    requireSession(),
    requirePermission({ crm: ["read"] }),
    async (c) => {
      const orgId = activeOrganizationId(c.get("session"));

      const [note] = await db
        .select()
        .from(schema.notes)
        .where(
          and(
            eq(schema.notes.id, c.req.param("id")),
            eq(schema.notes.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!note) return c.json({ error: "not found" }, 404);

      const index = Number(c.req.param("index"));
      const attachment = (note.attachments ?? [])[index];
      if (!attachment) return c.json({ error: "not found" }, 404);

      // The path came from the row, not the request — but it is still resolved
      // and checked against the directory, because a row written by an older
      // version is not a promise about today's code.
      const full = resolve(join(attachmentsDir(), attachment.path));
      if (!full.startsWith(resolve(attachmentsDir()))) {
        return c.json({ error: "not found" }, 404);
      }

      let bytes: Buffer;
      try {
        bytes = await readFile(full);
      } catch {
        // The row survived and the file did not — a half-restored backup, or
        // somebody tidying the disk. Saying so beats a 500.
        return c.json({ error: "that file is no longer on the server" }, 410);
      }

      return c.body(new Uint8Array(bytes), 200, {
        // Never the uploaded content type. An .html or .svg served back as
        // itself would run as this origin, with the signed-in user's session.
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${attachment.name.replaceAll('"', "")}"`,
        "x-content-type-options": "nosniff",
      });
    },
  );
}
