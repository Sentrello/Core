import type { CustomField } from "./crm-settings";
import { Field, Input, Select, formatDate, muted } from "./ui";

/**
 * The fields a business adds for itself, on a form.
 *
 * One component for contacts, companies and deals: the three forms would
 * otherwise each grow their own copy, and the third one would render dates as
 * text boxes because somebody forgot.
 */
export function CustomFields({
  fields,
  values,
  onChange,
}: {
  fields: CustomField[];
  values: Record<string, string | number | boolean | null>;
  onChange: (next: Record<string, string | number | boolean | null>) => void;
}) {
  if (fields.length === 0) return null;

  const set = (id: string, value: string | number | boolean | null) =>
    onChange({ ...values, [id]: value });

  return (
    <>
      {fields.map((field) => {
        const value = values[field.id];
        if (field.type === "checkbox") {
          return (
            <label
              key={field.id}
              className="flex items-center gap-2 self-end text-sm"
            >
              <input
                type="checkbox"
                checked={value === true}
                onChange={(e) => set(field.id, e.target.checked)}
              />
              {field.label}
            </label>
          );
        }
        return (
          <Field key={field.id} label={field.label}>
            {field.type === "select" ? (
              <Select
                value={
                  value === null || value === undefined ? "" : String(value)
                }
                onChange={(e) => set(field.id, e.target.value || null)}
              >
                <option value="">—</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                type={
                  field.type === "number"
                    ? "number"
                    : field.type === "date"
                      ? "date"
                      : "text"
                }
                value={
                  value === null || value === undefined ? "" : String(value)
                }
                onChange={(e) =>
                  set(
                    field.id,
                    e.target.value === ""
                      ? null
                      : field.type === "number"
                        ? Number(e.target.value)
                        : e.target.value,
                  )
                }
              />
            )}
          </Field>
        );
      })}
    </>
  );
}

/** The same fields read back, for a record screen rather than a form. */
export function CustomValues({
  fields,
  values,
}: {
  fields: CustomField[];
  values: Record<string, string | number | boolean | null> | null | undefined;
}) {
  const filled = fields.filter((f) => {
    const value = values?.[f.id];
    return value !== undefined && value !== null && value !== "";
  });
  if (filled.length === 0) return null;

  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      {filled.map((field) => {
        const value = values?.[field.id];
        return (
          <div key={field.id}>
            <p className="text-xs" style={muted}>
              {field.label}
            </p>
            <p className="text-sm">
              {field.type === "checkbox"
                ? value === true
                  ? "Yes"
                  : "No"
                : field.type === "date"
                  ? formatDate(String(value))
                  : String(value)}
            </p>
          </div>
        );
      })}
    </div>
  );
}
