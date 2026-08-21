import { useState } from "react";

/**
 * A picture where there is one, initials where there is not.
 *
 * Every list in the CRM shows one of these, and most records have no picture —
 * so the fallback is the common case and has to look deliberate rather than
 * broken. Initials on a colour derived from the name give a page of contacts
 * some shape to scan, which is the whole reason Atomic CRM's lists read as
 * quickly as they do.
 */

/**
 * The same name always gets the same colour, and it never depends on where the
 * record sits in a list — sorting a table must not repaint everybody.
 *
 * Hues only, at a fixed saturation and lightness, so nothing lands on
 * something unreadable or clashing with the accent.
 */
function hue(name: string): number {
  let total = 0;
  for (let i = 0; i < name.length; i += 1) {
    total = (total * 31 + name.charCodeAt(i)) % 360;
  }
  return total;
}

/** "Acme Roofing Ltd" → "AR"; "Jo" → "J". Two letters at most. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.[0] ?? "";
  const second = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
}

export function Avatar({
  src,
  name,
  size = 40,
  rounded = "full",
}: {
  /** Where the picture would be. It is fetched, and quietly absent if there is none. */
  src?: string | null;
  name: string;
  size?: number;
  /** Companies read better as a rounded square; people as a circle. */
  rounded?: "full" | "md";
}) {
  /**
   * The server answers 404 when a record has no picture, which is the normal
   * case rather than an error. Falling back on that keeps the list from having
   * to know in advance which records have one.
   */
  const [failed, setFailed] = useState(false);
  const shape = rounded === "full" ? "9999px" : "0.5rem";

  if (src && !failed) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        onError={() => setFailed(true)}
        className="shrink-0 object-cover"
        style={{ width: size, height: size, borderRadius: shape }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center font-semibold"
      style={{
        width: size,
        height: size,
        borderRadius: shape,
        fontSize: Math.max(11, Math.round(size * 0.38)),
        background: `oklch(0.92 0.04 ${hue(name)})`,
        color: `oklch(0.42 0.09 ${hue(name)})`,
      }}
    >
      {initials(name)}
    </span>
  );
}
