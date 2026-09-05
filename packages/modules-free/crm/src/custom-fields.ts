import { db, eq, schema } from "@sentrello/db";

/**
 * The fields a business adds for itself.
 *
 * A plumber wants "boiler model" on a contact; a studio wants a link to the
 * brand guidelines; a builder wants "site access" on a deal. None of those is
 * worth a migration, and a CRM that cannot hold the one thing a business
 * actually looks up is a CRM they keep a spreadsheet beside.
 *
 * Definitions live in the CRM settings and values in a JSON column on the
 * record. What matters here is that a value is only ever written against a
 * field somebody defined: the body of a request is not a schema, and without
 * this check any caller could write any key onto any record for ever.
 */

export type FieldType = "text" | "number" | "date" | "select" | "checkbox";
export type FieldSubject = "contact" | "company" | "deal";

export interface CustomField {
  id: string;
  label: string;
  type: FieldType;
  options?: string[];
  appliesTo: FieldSubject;
}

const TYPES: FieldType[] = ["text", "number", "date", "select", "checkbox"];
const SUBJECTS: FieldSubject[] = ["contact", "company", "deal"];

/** Lowercase, no spaces: it is a key in a JSON object and in a CSV header. */
export function fieldId(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

/**
 * What a business is allowed to define.
 *
 * Refused rather than repaired: a field silently renamed loses the values
 * already stored under its old id, which looks to whoever typed it like the
 * CRM forgot what they wrote.
 */
export function parseCustomFields(input: unknown): CustomField[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    throw new RangeError("custom fields must be a list");
  }
  if (input.length > 40) {
    throw new RangeError("that is more custom fields than a form can hold");
  }

  const seen = new Set<string>();
  return input.map((raw) => {
    const entry = raw as Record<string, unknown>;
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (!label) throw new RangeError("every custom field needs a label");

    const type = entry.type as FieldType;
    if (!TYPES.includes(type)) {
      throw new RangeError(`"${String(entry.type)}" is not a kind of field`);
    }
    const appliesTo = entry.appliesTo as FieldSubject;
    if (!SUBJECTS.includes(appliesTo)) {
      throw new RangeError(
        "a custom field belongs to a contact, a company or a deal",
      );
    }

    const id =
      typeof entry.id === "string" && entry.id.trim() !== ""
        ? fieldId(entry.id)
        : fieldId(label);
    if (!id) throw new RangeError(`"${label}" cannot be used as a field name`);

    // Two fields with one id on the same record would overwrite each other.
    const key = `${appliesTo}:${id}`;
    if (seen.has(key)) {
      throw new RangeError(`"${label}" is defined twice`);
    }
    seen.add(key);

    const options =
      type === "select"
        ? (Array.isArray(entry.options) ? entry.options : [])
            .map((o) => String(o).trim())
            .filter((o) => o !== "")
        : undefined;
    if (type === "select" && (!options || options.length === 0)) {
      throw new RangeError(`"${label}" is a list and has nothing to choose`);
    }

    return {
      id,
      label: label.slice(0, 60),
      type,
      ...(options ? { options } : {}),
      appliesTo,
    };
  });
}

/**
 * The values on the way in.
 *
 * Anything without a definition is dropped — not stored "just in case" — and
 * each value is coerced to what its field says it is, so a number field never
 * holds the string a browser sent.
 */
export function coerceCustomValues(
  fields: CustomField[],
  subject: FieldSubject,
  input: unknown,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!input || typeof input !== "object") return out;
  const given = input as Record<string, unknown>;

  for (const field of fields.filter((f) => f.appliesTo === subject)) {
    if (!(field.id in given)) continue;
    const value = given[field.id];
    if (value === null || value === "") {
      out[field.id] = null;
      continue;
    }

    switch (field.type) {
      case "number": {
        const n = Number(value);
        // Not a number is not stored: "about 30" in a number field would come
        // back as NaN and take every total that touched it with it.
        if (Number.isFinite(n)) out[field.id] = n;
        break;
      }
      case "checkbox":
        out[field.id] = value === true || value === "true";
        break;
      case "date": {
        const date = new Date(String(value));
        if (!Number.isNaN(date.getTime())) {
          out[field.id] = date.toISOString().slice(0, 10);
        }
        break;
      }
      case "select": {
        const chosen = String(value);
        // Only what the business put on the list. A stale option left over
        // from an old form is not quietly accepted.
        if (field.options?.includes(chosen)) out[field.id] = chosen;
        break;
      }
      default:
        out[field.id] = String(value).slice(0, 2000);
    }
  }
  return out;
}

/** The definitions for one organization, or none. */
export async function customFieldsFor(orgId: string): Promise<CustomField[]> {
  const [row] = await db
    .select({ customFields: schema.crmSettings.customFields })
    .from(schema.crmSettings)
    .where(eq(schema.crmSettings.organizationId, orgId))
    .limit(1);
  return row?.customFields ?? [];
}
