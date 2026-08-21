import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  muted,
} from "../lib/ui";

/**
 * The CRM's own settings: the pipeline, and the labels the business uses.
 *
 * The deal stages were a five-item constant in this file's neighbour, which
 * meant every business ran a process somebody else picked. A roofer's pipeline
 * is quote → measured → scheduled; a consultancy's is nothing like it.
 */

interface Settings {
  dealStages: { id: string; label: string }[];
  taskTypes: string[];
  usingDefaults: boolean;
}

interface Tag {
  id: string;
  name: string;
  color: string;
}

/** Muted enough to read against, distinct enough to scan by. */
const TAG_COLOURS = [
  "#94a3b8",
  "#f87171",
  "#fb923c",
  "#facc15",
  "#4ade80",
  "#38bdf8",
  "#a78bfa",
  "#f472b6",
];

export function CrmSettings() {
  const qc = useQueryClient();

  const settings = useQuery({
    queryKey: ["crm-settings"],
    queryFn: () => api<Settings>("/api/crm/settings"),
  });
  const tags = useQuery({
    queryKey: ["tags"],
    queryFn: () => api<{ tags: Tag[] }>("/api/tags"),
  });

  /**
   * Held locally while being edited, saved on a press.
   *
   * A pipeline is rearranged in several moves — rename one, add another, drag
   * a third — and saving each keystroke would mean a half-renamed stage
   * reaching the board somebody else is looking at.
   */
  const [stages, setStages] = useState<Settings["dealStages"] | null>(null);
  const [types, setTypes] = useState<string[] | null>(null);
  const [newTag, setNewTag] = useState("");

  const save = useMutation({
    mutationFn: (body: {
      dealStages: Settings["dealStages"];
      taskTypes: string[];
    }) =>
      api<Settings>("/api/crm/settings", {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    onSuccess: (saved) => {
      setStages(null);
      setTypes(null);
      qc.setQueryData(["crm-settings"], saved);
      // The board draws itself from these.
      qc.invalidateQueries({ queryKey: ["deals"] });
    },
  });

  const addTag = useMutation({
    mutationFn: (name: string) =>
      api("/api/tags", {
        method: "POST",
        body: JSON.stringify({
          name,
          color:
            TAG_COLOURS[(tags.data?.tags.length ?? 0) % TAG_COLOURS.length],
        }),
      }),
    onSuccess: () => {
      setNewTag("");
      qc.invalidateQueries({ queryKey: ["tags"] });
    },
  });

  const recolour = useMutation({
    mutationFn: ({ id, color }: { id: string; color: string }) =>
      api(`/api/tags/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ color }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tags"] }),
  });

  const removeTag = useMutation({
    mutationFn: (id: string) =>
      api<{ removedFrom: number }>(`/api/crm/tags/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tags"] }),
  });

  if (settings.isLoading) return <Loading />;
  if (settings.error) return <ErrorNote error={settings.error} />;
  if (!settings.data) return null;

  const current = stages ?? settings.data.dealStages;
  const currentTypes = types ?? settings.data.taskTypes;
  const dirty = stages !== null || types !== null;

  const move = (index: number, by: number) => {
    const next = [...current];
    const target = index + by;
    if (target < 0 || target >= next.length) return;
    const [row] = next.splice(index, 1);
    if (row) next.splice(target, 0, row);
    setStages(next);
  };

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <div className="mb-1 flex items-baseline justify-between">
          <p className="font-medium">Your pipeline</p>
          {settings.data.usingDefaults && !dirty ? (
            <span className="text-xs" style={muted}>
              using the defaults
            </span>
          ) : null}
        </div>
        <p className="mb-3 text-sm" style={muted}>
          The columns on the deals board, left to right. Rename them to match
          what you actually do — a stage keeps its deals when you rename it.
        </p>

        <ul className="space-y-2">
          {current.map((stage, index) => (
            <li key={stage.id} className="flex items-center gap-2">
              <Input
                value={stage.label}
                onChange={(e) => {
                  const next = [...current];
                  next[index] = { ...stage, label: e.target.value };
                  setStages(next);
                }}
              />
              <button
                type="button"
                className="px-1 text-sm"
                style={muted}
                aria-label="Move earlier"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="px-1 text-sm"
                style={muted}
                aria-label="Move later"
                disabled={index === current.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="px-1 text-sm underline"
                style={muted}
                disabled={current.length === 1}
                onClick={() => setStages(current.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>

        <div className="mt-2">
          <Button
            variant="secondary"
            onClick={() =>
              setStages([...current, { id: "", label: "New stage" }])
            }
          >
            Add a stage
          </Button>
        </div>
      </Card>

      <Card>
        <p className="mb-1 font-medium">Follow-up types</p>
        <p className="mb-3 text-sm" style={muted}>
          What a task can be: a call, a site visit, whatever you log.
        </p>
        <div className="flex flex-wrap gap-2">
          {currentTypes.map((type, index) => (
            <span key={type} className="flex items-center gap-1">
              <Input
                value={type}
                className="w-36"
                onChange={(e) => {
                  const next = [...currentTypes];
                  next[index] = e.target.value;
                  setTypes(next);
                }}
              />
              <button
                type="button"
                className="text-sm underline"
                style={muted}
                disabled={currentTypes.length === 1}
                onClick={() =>
                  setTypes(currentTypes.filter((_, i) => i !== index))
                }
              >
                ×
              </button>
            </span>
          ))}
          <Button
            variant="secondary"
            onClick={() => setTypes([...currentTypes, "visit"])}
          >
            Add
          </Button>
        </div>
      </Card>

      {dirty ? (
        <Card>
          <div className="flex items-center gap-3">
            <Button
              onClick={() =>
                save.mutate({ dealStages: current, taskTypes: currentTypes })
              }
              disabled={save.isPending}
            >
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
            <button
              type="button"
              className="text-sm underline"
              style={muted}
              onClick={() => {
                setStages(null);
                setTypes(null);
              }}
            >
              Discard
            </button>
          </div>
          {save.error ? <ErrorNote error={save.error} /> : null}
        </Card>
      ) : null}

      <Card>
        <p className="mb-1 font-medium">Tags</p>
        <p className="mb-3 text-sm" style={muted}>
          Labels you put on contacts. Deleting one takes it off everybody who
          has it.
        </p>

        {tags.data?.tags.length ? (
          <ul className="mb-3 space-y-1">
            {tags.data.tags.map((tag) => (
              <li
                key={tag.id}
                className="flex items-center gap-3 border-t py-2 first:border-0"
                style={{ borderColor: "var(--border)" }}
              >
                <span
                  aria-hidden="true"
                  className="size-3 shrink-0 rounded-full"
                  style={{ background: tag.color }}
                />
                <span className="flex-1 text-sm">{tag.name}</span>
                <span className="flex gap-1">
                  {TAG_COLOURS.map((colour) => (
                    <button
                      key={colour}
                      type="button"
                      aria-label={`Colour ${tag.name}`}
                      className="size-4 rounded-full border"
                      style={{
                        background: colour,
                        borderColor:
                          colour === tag.color ? "var(--text)" : "transparent",
                      }}
                      onClick={() =>
                        recolour.mutate({ id: tag.id, color: colour })
                      }
                    />
                  ))}
                </span>
                <button
                  type="button"
                  className="text-sm underline"
                  style={muted}
                  onClick={() => removeTag.mutate(tag.id)}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-3 text-sm" style={muted}>
            No tags yet.
          </p>
        )}

        <Field label="Add a tag">
          <div className="flex gap-2">
            <Input
              value={newTag}
              placeholder="Repeat customer"
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && newTag.trim()) {
                  e.preventDefault();
                  addTag.mutate(newTag.trim());
                }
              }}
            />
            <Button
              onClick={() => addTag.mutate(newTag.trim())}
              disabled={!newTag.trim() || addTag.isPending}
            >
              Add
            </Button>
          </div>
        </Field>
        {addTag.error ? <ErrorNote error={addTag.error} /> : null}
        {removeTag.error ? <ErrorNote error={removeTag.error} /> : null}
      </Card>
    </div>
  );
}
