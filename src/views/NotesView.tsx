import { useEffect, useState } from "react";
import { Plus, Pin } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { NoteRow } from "../types";
import { listNotes, upsertNote, searchNotes, allLinkTargets } from "../db";
import { Button } from "../components/ui";
import { releaseNoteImages } from "../components/NoteImage";
import MarkdownDocEditor from "../components/MarkdownDocEditor";
import { LinkTarget } from "../components/ItemMeta";
import { useFirstLoad, firstLoadScreen, SlowLoad } from "../components/ViewGate";

export default function NotesView({ onChange, initialId }: { onChange: () => void; initialId?: string }) {
  const { t } = useTranslation();
  const [notes, setNotes] = useState<NoteRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialId ?? null);
  const [query, setQuery] = useState("");
  const [targets, setTargets] = useState<LinkTarget[]>([]);

  const reload = async () => {
    const list = query.trim() ? await searchNotes(query, "note") : await listNotes("note");
    setNotes(list);
    setTargets(await allLinkTargets());
  };
  // Only the first load blocks the page: typing in the search box re-runs this
  // and must keep the current list visible rather than flashing a spinner.
  const gate = useFirstLoad(reload, [query]);

  // Cached image object URLs are shared across notes, so they're only revoked
  // when the whole view goes away — not on every note switch.
  useEffect(() => releaseNoteImages, []);

  const selected = notes.find((n) => n.id === selectedId) ?? null;
  const bump = () => { void reload(); onChange(); };

  async function createNote() {
    const id = await upsertNote({ title: "", body: "", pinned: 0 });
    await reload();
    setSelectedId(id); // open it immediately for editing
    onChange();
  }

  const blocked = firstLoadScreen(gate);
  if (blocked) return blocked;

  return (
    <div className="flex h-full">
      <SlowLoad state={gate} />
      {/* Notes list. Below `md` the two panes take turns owning the whole
          screen — a 288px list beside an editor leaves neither usable on a
          phone — and the editor's back button returns here. From `md` up both
          are always mounted and visible, exactly as before. */}
      <aside className={`w-full shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-700 md:flex md:w-72 ${selected ? "hidden" : "flex"}`}>
        <div className="space-y-2 border-b border-neutral-200 p-3 dark:border-neutral-700">
          <Button variant="primary" className="w-full" onClick={createNote}><span className="flex items-center justify-center gap-1.5"><Plus size={16} /> {t("notes.newNote")}</span></Button>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("notes.searchPlaceholder")}
            className="w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {notes.map((n) => (
            <button
              key={n.id}
              onClick={() => setSelectedId(n.id)}
              className={`block w-full border-b border-neutral-100 px-3 py-2 text-left dark:border-neutral-800 ${
                selectedId === n.id ? "bg-blue-50 dark:bg-blue-900/30" : "hover:bg-neutral-50 dark:hover:bg-neutral-800"
              }`}
            >
              <div className="flex items-center gap-1 truncate font-medium">
                {n.pinned === 1 && <Pin size={13} className="shrink-0 text-blue-500" fill="currentColor" />}
                {n.title || t("common.untitled")}
              </div>
              <div className="truncate text-xs text-neutral-400">
                {(n.body ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || t("notes.noContent")}
              </div>
            </button>
          ))}
          {notes.length === 0 && <p className="p-4 text-sm text-neutral-400">{t("notes.noneFound")}</p>}
        </div>
      </aside>

      {/* Editor — keyed by note id so local state resets cleanly on selection change */}
      <div className={`flex-1 overflow-y-auto ${selected ? "" : "hidden md:block"}`}>
        {selected ? (
          <MarkdownDocEditor
            key={selected.id}
            note={selected}
            targets={targets}
            onChanged={bump}
            onDeleted={() => { setSelectedId(null); bump(); }}
            onBack={() => setSelectedId(null)}
            titlePlaceholder={t("notes.titlePlaceholder")}
            confirmDelete={t("notes.confirmDelete")}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-neutral-400">
            {t("notes.selectOrCreate")}
          </div>
        )}
      </div>
    </div>
  );
}
