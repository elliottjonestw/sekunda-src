// Reusable Tags + Links panel. Drop it into any item's detail/edit view; it
// works for events, reminders, and notes uniformly via the shared
// item_tags and links tables — the whole point of the cross-linking design.

import { useEffect, useState } from "react";
import { X, Link2, Plus, UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ItemType, TagRow, LinkRow, PersonRow } from "../types";
import {
  tagsForItem, tagItem, untagItem,
  linksForItem, createLink, deleteLink, getItemLabel, listPeople,
} from "../db";
import { Button } from "./ui";
import { Avatar } from "./Avatar";

export function TagEditor({ type, id }: { type: ItemType; id: string }) {
  const { t: tr } = useTranslation();
  const [tags, setTags] = useState<TagRow[]>([]);
  const [input, setInput] = useState("");

  const reload = () => tagsForItem(type, id).then(setTags);
  useEffect(() => { void reload(); }, [type, id]);

  async function add() {
    const name = input.trim();
    if (!name) return;
    await tagItem(name, type, id);
    setInput("");
    void reload();
  }

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-neutral-500">{tr("meta.tags")}</label>
      <div className="flex flex-wrap items-center gap-1.5">
        {tags.map((t) => (
          <span key={t.id} className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs dark:bg-neutral-700">
            #{t.name}
            <button
              onClick={async () => { await untagItem(t.id, type, id); void reload(); }}
              className="text-neutral-400 hover:text-red-500"
              aria-label={tr("meta.removeTag", { name: t.name })}
            ><X size={12} /></button>
          </span>
        ))}
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void add())}
          placeholder={tr("meta.addTag")}
          className="w-32 rounded border border-neutral-200 px-2 py-0.5 text-xs outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-700"
        />
      </div>
    </div>
  );
}

/** Options for the "link to…" picker: every item except the current one. */
export interface LinkTarget { type: ItemType; id: string; label: string; }

export function LinksPanel({
  type, id, targets,
}: {
  type: ItemType;
  id: string;
  targets: LinkTarget[];
}) {
  const { t: tr } = useTranslation();
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState(false);

  const reload = async () => {
    const ls = await linksForItem(type, id);
    setLinks(ls);
    const entries = await Promise.all(
      ls.map(async (l) => {
        const other = l.source_type === type && l.source_id === id
          ? { t: l.target_type, i: l.target_id }
          : { t: l.source_type, i: l.source_id };
        return [l.id, `${tr(`itemType.${other.t}`)}: ${await getItemLabel(other.t, other.i)}`] as const;
      }),
    );
    setLabels(Object.fromEntries(entries));
  };
  useEffect(() => { void reload(); }, [type, id]);

  const available = targets.filter((t) => !(t.type === type && t.id === id));

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-neutral-500">{tr("meta.linkedItems")}</label>
      <div className="space-y-1">
        {links.map((l) => (
          <div key={l.id} className="flex items-center justify-between rounded bg-neutral-50 px-2 py-1 text-xs dark:bg-neutral-700/50">
            <span className="flex items-center gap-1.5"><Link2 size={13} className="text-neutral-400" /> {labels[l.id] ?? "…"}</span>
            <button
              onClick={async () => { await deleteLink(l.id); void reload(); }}
              className="text-neutral-400 hover:text-red-500"
              aria-label={tr("meta.removeLink")}
            ><X size={12} /></button>
          </div>
        ))}
        {links.length === 0 && <p className="text-xs text-neutral-400">{tr("meta.noLinks")}</p>}
      </div>

      {picking ? (
        <select
          autoFocus
          className="mt-2 w-full rounded border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-600 dark:bg-neutral-700"
          onChange={async (e) => {
            const [t, i] = e.target.value.split("::");
            if (t && i) { await createLink(type, id, t as ItemType, i); }
            setPicking(false);
            void reload();
          }}
          defaultValue=""
        >
          <option value="" disabled>{tr("meta.chooseItem")}</option>
          {available.map((t) => (
            <option key={`${t.type}::${t.id}`} value={`${t.type}::${t.id}`}>
              {tr(`itemType.${t.type}`)}: {t.label}
            </option>
          ))}
        </select>
      ) : (
        <Button variant="ghost" className="mt-1 px-1" onClick={() => setPicking(true)}><span className="flex items-center gap-1"><Plus size={14} /> {tr("meta.linkItem")}</span></Button>
      )}
    </div>
  );
}

/**
 * First-class "People" affordance for any item's editor. It's UX sugar over the
 * same generic `links` table the LinksPanel uses — just scoped to person links —
 * so attaching a person here shows up as a link everywhere (and vice-versa).
 */
export function PeoplePanel({ type, id }: { type: ItemType; id: string }) {
  const { t: tr } = useTranslation();
  const [everyone, setEveryone] = useState<PersonRow[]>([]);
  const [linked, setLinked] = useState<{ linkId: string; person: PersonRow }[]>([]);
  const [picking, setPicking] = useState(false);

  const reload = async () => {
    const all = await listPeople();
    setEveryone(all);
    const links = await linksForItem(type, id);
    const byId = new Map(all.map((p) => [p.id, p]));
    const rows = links
      .map((l) => {
        const other = l.source_type === type && l.source_id === id
          ? { t: l.target_type, i: l.target_id }
          : { t: l.source_type, i: l.source_id };
        const person = other.t === "person" ? byId.get(other.i) : undefined;
        return person ? { linkId: l.id, person } : null;
      })
      .filter((r): r is { linkId: string; person: PersonRow } => r !== null);
    setLinked(rows);
  };
  useEffect(() => { void reload(); }, [type, id]);

  const available = everyone.filter((p) => !linked.some((l) => l.person.id === p.id));

  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-neutral-500">{tr("meta.people")}</label>
      <div className="flex flex-wrap items-center gap-1.5">
        {linked.map(({ linkId, person }) => (
          <span key={linkId} className="inline-flex items-center gap-1.5 rounded-full bg-neutral-100 py-0.5 pl-0.5 pr-2 text-xs dark:bg-neutral-700">
            <Avatar name={person.full_name || tr("people.newContact")} photo={person.photo} size={20} />
            {person.full_name || tr("people.newContact")}
            <button
              onClick={async () => { await deleteLink(linkId); void reload(); }}
              className="text-neutral-400 hover:text-red-500"
              aria-label={tr("meta.removePerson", { name: person.full_name })}
            ><X size={12} /></button>
          </span>
        ))}
        {linked.length === 0 && <p className="text-xs text-neutral-400">{tr("meta.noPeople")}</p>}
      </div>

      {picking ? (
        <select
          autoFocus
          className="mt-2 w-full rounded border border-neutral-200 px-2 py-1 text-xs dark:border-neutral-600 dark:bg-neutral-700"
          onChange={async (e) => {
            const personId = e.target.value;
            if (personId) { await createLink(type, id, "person", personId); }
            setPicking(false);
            void reload();
          }}
          defaultValue=""
        >
          <option value="" disabled>{tr("meta.choosePerson")}</option>
          {available.map((p) => (
            <option key={p.id} value={p.id}>{p.full_name || tr("people.newContact")}</option>
          ))}
        </select>
      ) : (
        <Button variant="ghost" className="mt-1 px-1" onClick={() => setPicking(true)}><span className="flex items-center gap-1"><UserPlus size={14} /> {tr("meta.addPerson")}</span></Button>
      )}
    </div>
  );
}
