import { Fragment, useEffect, useRef, useState } from "react";
import {
  Plus, X, Trash2, Star, Mail, Phone, ExternalLink, ChevronUp, ChevronDown, Pencil, Eye, ArrowLeft,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTranslation } from "react-i18next";
import type {
  PersonRow, PersonEmail, PersonPhone, PersonAddress, PersonUrl, PersonCustomField,
} from "../types";
import {
  listPeople, searchPeople, upsertPerson, deletePerson, allLinkTargets,
  listCustomFields, ensureCustomField, deleteCustomFieldDef, reorderCustomFields,
  CustomFieldDef,
} from "../db";
import { Button, Modal } from "../components/ui";
import { Avatar } from "../components/Avatar";
import { PhotoPicker } from "../components/PhotoPicker";
import { TagEditor, LinksPanel, LinkTarget } from "../components/ItemMeta";
import { fmtFullDate, fmtMonthDay, ageFromBirthday, parseBirthday } from "../lib/format";
import { useFirstLoad, firstLoadScreen, SlowLoad } from "../components/ViewGate";

// Type presets for the multi-value editors (matches vCard TYPE params).
const EMAIL_TYPES = ["home", "work", "other"];
const PHONE_TYPES = ["cell", "home", "work", "other"];
const ADDR_TYPES = ["home", "work", "other"];
const URL_TYPES = ["homepage", "work", "social", "other"];

// --- small helpers ------------------------------------------------------------
function parseArr<T>(json: string | null): T[] {
  if (!json) return [];
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; } catch { return []; }
}
const nz = (s: string): string | null => (s.trim() ? s.trim() : null);
const arrOrNull = (a: unknown[]): string | null => (a.length ? JSON.stringify(a) : null);

/** A blank person, used when creating. full_name may be empty (like a new note). */
function emptyPersonInput() {
  return {
    full_name: "", given_name: null, family_name: null, additional_names: null,
    honorific_prefix: null, honorific_suffix: null, nickname: null,
    emails: null, phones: null, addresses: null, organization: null, title: null,
    birthday: null, urls: null, notes: null, photo: null, custom_fields: null,
    favorite: 0,
  };
}

export default function PeopleView({ onChange, initialId }: { onChange: () => void; initialId?: string }) {
  const { t } = useTranslation();
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(initialId ?? null);
  const [query, setQuery] = useState("");
  const [targets, setTargets] = useState<LinkTarget[]>([]);

  const reload = async () => {
    const list = query.trim() ? await searchPeople(query) : await listPeople();
    setPeople(list);
    setTargets(await allLinkTargets());
  };
  // Only the first load blocks the page: typing in the search box re-runs this
  // and must keep the current list visible rather than flashing a spinner.
  const gate = useFirstLoad(reload, [query]);

  const selected = people.find((p) => p.id === selectedId) ?? null;
  const bump = () => { void reload(); onChange(); };

  async function createPerson() {
    const id = await upsertPerson(emptyPersonInput());
    setQuery("");
    setPeople(await listPeople());
    setTargets(await allLinkTargets());
    setSelectedId(id); // open it immediately for editing
    onChange();
  }

  const blocked = firstLoadScreen(gate);
  if (blocked) return blocked;

  return (
    <div className="flex h-full">
      <SlowLoad state={gate} />
      {/* People list. Below `md` the list and the detail take turns owning the
          screen (the detail's back button returns here); from `md` up both are
          visible side by side exactly as before. */}
      <aside className={`w-full shrink-0 flex-col border-r border-neutral-200 dark:border-neutral-700 md:flex md:w-72 ${selected ? "hidden" : "flex"}`}>
        <div className="space-y-2 border-b border-neutral-200 p-3 dark:border-neutral-700">
          <Button variant="primary" className="w-full" onClick={createPerson}>
            <span className="flex items-center justify-center gap-1.5"><Plus size={16} /> {t("people.newPerson")}</span>
          </Button>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("people.searchPlaceholder")}
            className="w-full rounded-lg border border-neutral-200 px-3 py-1.5 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-800"
          />
        </div>
        <div className="flex-1 overflow-y-auto">
          {people.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={`flex w-full items-center gap-3 border-b border-neutral-100 px-3 py-2 text-left dark:border-neutral-800 ${
                selectedId === p.id ? "bg-blue-50 dark:bg-blue-900/30" : "hover:bg-neutral-50 dark:hover:bg-neutral-800"
              }`}
            >
              <Avatar name={p.full_name} photo={p.photo} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1 truncate font-medium">
                  {p.favorite === 1 && <Star size={13} className="shrink-0 text-amber-400" fill="currentColor" />}
                  {p.full_name || t("people.newContact")}
                </span>
                {p.organization && <span className="block truncate text-xs text-neutral-400">{p.organization}</span>}
              </span>
            </button>
          ))}
          {people.length === 0 && <p className="p-4 text-sm text-neutral-400">{t("people.noneFound")}</p>}
        </div>
      </aside>

      {/* Detail / editor — keyed by id so local state resets on selection change */}
      <div className={`flex-1 overflow-y-auto ${selected ? "" : "hidden md:block"}`}>
        {selected ? (
          <PersonEditor
            key={selected.id}
            person={selected}
            targets={targets}
            onChanged={bump}
            onDeleted={() => { setSelectedId(null); bump(); }}
            onBack={() => setSelectedId(null)}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-neutral-400">
            {t("people.selectOrCreate")}
          </div>
        )}
      </div>
    </div>
  );
}

// --- editor -------------------------------------------------------------------
interface Draft {
  full_name: string;
  honorific_prefix: string;
  given_name: string;
  additional_names: string;
  family_name: string;
  honorific_suffix: string;
  nickname: string;
  organization: string;
  title: string;
  birthday: string; // yyyy-mm-dd or ""
  notes: string;
  photo: string;
  favorite: boolean;
  emails: PersonEmail[];
  phones: PersonPhone[];
  addresses: PersonAddress[];
  urls: PersonUrl[];
  custom_fields: PersonCustomField[];
}

function toDraft(p: PersonRow): Draft {
  return {
    full_name: p.full_name ?? "",
    honorific_prefix: p.honorific_prefix ?? "",
    given_name: p.given_name ?? "",
    additional_names: p.additional_names ?? "",
    family_name: p.family_name ?? "",
    honorific_suffix: p.honorific_suffix ?? "",
    nickname: p.nickname ?? "",
    organization: p.organization ?? "",
    title: p.title ?? "",
    birthday: p.birthday ?? "",
    notes: p.notes ?? "",
    photo: p.photo ?? "",
    favorite: p.favorite === 1,
    emails: parseArr<PersonEmail>(p.emails),
    phones: parseArr<PersonPhone>(p.phones),
    addresses: parseArr<PersonAddress>(p.addresses),
    urls: parseArr<PersonUrl>(p.urls),
    custom_fields: parseArr<PersonCustomField>(p.custom_fields),
  };
}

/**
 * True for a person with nothing filled in — i.e. one that was just created.
 * Tested on the row rather than the draft so it reflects what's stored, not
 * what's been typed since.
 */
function isBlank(p: PersonRow): boolean {
  return !(
    p.full_name?.trim() || p.nickname || p.organization || p.title || p.birthday ||
    p.notes || p.photo || p.favorite === 1 ||
    // Empty multi-value fields are normally stored as NULL, but "[]" is a
    // legal value too — parse rather than trusting the column to be null.
    parseArr(p.emails).length || parseArr(p.phones).length ||
    parseArr(p.addresses).length || parseArr(p.urls).length ||
    parseArr(p.custom_fields).length
  );
}

function PersonEditor({
  person, targets, onChanged, onDeleted, onBack,
}: {
  person: PersonRow;
  targets: LinkTarget[];
  onChanged: () => void;
  onDeleted: () => void;
  /** Back to the list. Only reachable below `md`, where the panes alternate. */
  onBack: () => void;
}) {
  const { t } = useTranslation();
  // Local state is the source of truth while editing; DB writes are debounced
  // (400ms) and flushed on unmount, so typing stays instant and the row never
  // re-fetches out from under the editor. Same pattern as the Notes editor.
  const [form, setForm] = useState<Draft>(() => toDraft(person));
  // Existing people open read-only; a freshly-created (blank) person opens
  // straight into the form, same rule as the Notes editor. Evaluated once —
  // the detail is keyed by id, so selecting another person remounts and
  // re-evaluates, which is what sends you back to preview.
  const [preview, setPreview] = useState(() => !isBlank(person));
  const formRef = useRef(form);
  formRef.current = form;
  const firstRender = useRef(true);
  const dirty = useRef(false);
  const saveTimer = useRef<number | null>(null);

  const patch = (p: Partial<Draft>) => setForm((f) => ({ ...f, ...p }));

  async function persist(draft: Draft) {
    await upsertPerson({
      id: person.id,
      full_name: draft.full_name.trim(),
      honorific_prefix: nz(draft.honorific_prefix),
      given_name: nz(draft.given_name),
      additional_names: nz(draft.additional_names),
      family_name: nz(draft.family_name),
      honorific_suffix: nz(draft.honorific_suffix),
      nickname: nz(draft.nickname),
      organization: nz(draft.organization),
      title: nz(draft.title),
      birthday: nz(draft.birthday),
      notes: nz(draft.notes),
      photo: nz(draft.photo),
      favorite: draft.favorite ? 1 : 0,
      emails: arrOrNull(draft.emails.filter((e) => e.value.trim())),
      phones: arrOrNull(draft.phones.filter((e) => e.value.trim())),
      addresses: arrOrNull(draft.addresses.filter(hasAddress)),
      urls: arrOrNull(draft.urls.filter((u) => u.value.trim())),
      custom_fields: arrOrNull(draft.custom_fields.filter((c) => c.label.trim() && c.value.trim())),
    });
    onChanged();
  }

  // Debounce a save whenever the form changes (skip the initial mount).
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    dirty.current = true;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      saveTimer.current = null;
      dirty.current = false;
      await persist(formRef.current);
    }, 400);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  // Flush any pending save exactly once, on unmount (switching person/view).
  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    if (dirty.current) void persist(formRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const display = form.full_name.trim() || t("people.newContact");
  // Job line: "Engineer at Acme", or whichever half exists.
  const subtitle = [form.title.trim(), form.organization.trim()].filter(Boolean).join(" · ");

  return (
    <div className="mx-auto max-w-3xl p-4 md:p-6">
      {/* Header. Wraps onto two lines below `md` — identity first, then the
          actions — while the inner `md:flex-1` wrapper reproduces the single
          desktop row exactly. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 md:gap-4">
        <div className="flex w-full min-w-0 items-center gap-4 md:w-auto md:flex-1">
          <button
            onClick={onBack}
            aria-label={t("common.back")}
            className="-ml-1 -mr-2 shrink-0 rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-700 md:hidden"
          >
            <ArrowLeft size={20} />
          </button>
          {preview ? (
            <Avatar name={display} photo={form.photo} size={56} />
          ) : (
            <PhotoPicker name={display} value={form.photo} onChange={(photo) => patch({ photo })} size={56} />
          )}
          {preview ? (
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-2xl font-bold dark:text-neutral-100">{display}</h2>
              {subtitle && <p className="truncate text-sm text-neutral-500">{subtitle}</p>}
            </div>
          ) : (
            <input
              value={form.full_name}
              onChange={(e) => patch({ full_name: e.target.value })}
              placeholder={t("people.fullName")}
              className="min-w-0 flex-1 bg-transparent text-2xl font-bold outline-none"
            />
          )}
        </div>
        <Button variant="ghost" onClick={() => patch({ favorite: !form.favorite })} aria-label={form.favorite ? t("people.unfavorite") : t("people.favorite")}>
          <Star size={18} className={form.favorite ? "text-amber-400" : "text-neutral-400"} fill={form.favorite ? "currentColor" : "none"} />
        </Button>
        <Button variant="ghost" onClick={() => setPreview((v) => !v)}>
          <span className="flex items-center gap-1.5">
            {preview ? <><Pencil size={15} /> {t("people.edit")}</> : <><Eye size={15} /> {t("people.done")}</>}
          </span>
        </Button>
        <Button
          variant="danger"
          onClick={async () => {
            if (confirm(t("people.confirmDelete", { name: display }))) {
              if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
              dirty.current = false;
              await deletePerson(person.id);
              onDeleted();
            }
          }}
        >
          <span className="flex items-center gap-1.5"><Trash2 size={15} /> {t("common.delete")}</span>
        </Button>
      </div>

      <div className="space-y-5">
        {preview ? <PersonSummary form={form} /> : <>
        {/* Basics */}
        <Section title={t("people.details")}>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label={t("people.nickname")}><input value={form.nickname} onChange={(e) => patch({ nickname: e.target.value })} className={inputCls} /></Field>
            <Field label={t("people.birthday")}><input type="date" value={form.birthday} onChange={(e) => patch({ birthday: e.target.value })} className={inputCls} /></Field>
            <Field label={t("people.organization")}><input value={form.organization} onChange={(e) => patch({ organization: e.target.value })} className={inputCls} /></Field>
            <Field label={t("people.jobTitle")}><input value={form.title} onChange={(e) => patch({ title: e.target.value })} className={inputCls} /></Field>
          </div>
        </Section>

        {/* Structured name (vCard N) */}
        <Section title={t("people.nameDetails")}>
          {/* Five name parts fit a desktop row; on a phone they stack two
              per line rather than shrinking to unusable slivers. */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            <Field label={t("people.prefix")}><input value={form.honorific_prefix} onChange={(e) => patch({ honorific_prefix: e.target.value })} className={inputCls} /></Field>
            <Field label={t("people.first")}><input value={form.given_name} onChange={(e) => patch({ given_name: e.target.value })} className={inputCls} /></Field>
            <Field label={t("people.middle")}><input value={form.additional_names} onChange={(e) => patch({ additional_names: e.target.value })} className={inputCls} /></Field>
            <Field label={t("people.last")}><input value={form.family_name} onChange={(e) => patch({ family_name: e.target.value })} className={inputCls} /></Field>
            <Field label={t("people.suffix")}><input value={form.honorific_suffix} onChange={(e) => patch({ honorific_suffix: e.target.value })} className={inputCls} /></Field>
          </div>
        </Section>

        {/* Emails */}
        <Section title={t("people.email")}>
          <TypedValueRows
            rows={form.emails}
            typeOptions={EMAIL_TYPES}
            placeholder="name@example.com"
            onChange={(rows) => patch({ emails: rows })}
            onOpen={(v) => void openUrl(`mailto:${v}`)}
            openIcon={<Mail size={14} />}
          />
        </Section>

        {/* Phones */}
        <Section title={t("people.phone")}>
          <TypedValueRows
            rows={form.phones}
            typeOptions={PHONE_TYPES}
            placeholder="+1 555 010 1234"
            onChange={(rows) => patch({ phones: rows })}
            onOpen={(v) => void openUrl(`tel:${v.replace(/\s+/g, "")}`)}
            openIcon={<Phone size={14} />}
          />
        </Section>

        {/* URLs */}
        <Section title={t("people.websites")}>
          <TypedValueRows
            rows={form.urls}
            typeOptions={URL_TYPES}
            placeholder="https://example.com"
            onChange={(rows) => patch({ urls: rows })}
            onOpen={(v) => void openUrl(/^https?:\/\//i.test(v) ? v : `https://${v}`)}
            openIcon={<ExternalLink size={14} />}
          />
        </Section>

        {/* Addresses */}
        <Section title={t("people.addresses")}>
          <AddressRows rows={form.addresses} onChange={(rows) => patch({ addresses: rows })} />
        </Section>

        {/* Custom fields — labels are global (shared across all people). */}
        <Section title={t("people.customFields")}>
          <CustomFields values={form.custom_fields} onChange={(rows) => patch({ custom_fields: rows })} />
        </Section>

        {/* Notes */}
        <Section title={t("nav.notes")}>
          <textarea
            value={form.notes}
            onChange={(e) => patch({ notes: e.target.value })}
            placeholder={t("people.notesPlaceholder")}
            rows={3}
            className="w-full rounded-lg border border-neutral-200 px-3 py-2 text-sm outline-none focus:border-blue-400 dark:border-neutral-700 dark:bg-neutral-800"
          />
        </Section>

        </>}

        {/* Tags + Links — the cross-app integration. Shown in both modes: they
            write straight to the DB rather than through the draft, so there's
            nothing to "save", and Notes shows them in preview too. */}
        <div className="grid grid-cols-1 gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700 sm:grid-cols-2">
          <TagEditor type="person" id={person.id} />
          <LinksPanel type="person" id={person.id} targets={targets} />
        </div>
      </div>
    </div>
  );
}

// --- read-only summary --------------------------------------------------------
// Renders the draft, not the row, so switching out of edit shows what you just
// typed rather than waiting for the debounced save + reload to land.
// Empty fields are omitted entirely, sections included: a sparse contact shows
// a short page, not a page of blanks.

/**
 * A birthday is a bare `yyyy-mm-dd`; build a *local* date so it doesn't render
 * a day early west of UTC (`new Date("1990-05-04")` parses as UTC midnight).
 *
 * Also accepts vCard's no-year form (`--05-14`, "we know the day, not the age")
 * via the shared parser, rendering month/day only with the same helper the
 * Today dashboard uses for birthdays. `ageFromBirthday` already returns null
 * for these, so the Age row stays hidden; only the Birthday row needs this.
 */
function birthdayLabel(value: string): string | null {
  const b = parseBirthday(value);
  if (!b) return null;
  // 2000 is an arbitrary leap-year placeholder for the no-year case; only
  // month/day are rendered then.
  const date = new Date(b.year ?? 2000, b.month - 1, b.day);
  return b.year ? fmtFullDate(date) : fmtMonthDay(date);
}

function formatAddress(a: PersonAddress): string {
  return [a.street, [a.postal_code, a.city].filter(Boolean).join(" "), a.region, a.country]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join("\n");
}

function PersonSummary({ form }: { form: Draft }) {
  const { t } = useTranslation();
  const emails = form.emails.filter((e) => e.value.trim());
  const phones = form.phones.filter((p) => p.value.trim());
  const urls = form.urls.filter((u) => u.value.trim());
  const addresses = form.addresses.filter(hasAddress);
  const custom = form.custom_fields.filter((c) => c.label.trim() && c.value.trim());
  const birthday = form.birthday ? birthdayLabel(form.birthday) : null;
  // Its own row rather than "28 January 1986 (40)" — no string to assemble, so
  // nothing to get wrong per language.
  const age = form.birthday ? ageFromBirthday(form.birthday) : null;
  const details: [string, string][] = [
    ...(form.nickname.trim() ? [[t("people.nickname"), form.nickname.trim()] as [string, string]] : []),
    ...(birthday ? [[t("people.birthday"), birthday] as [string, string]] : []),
    ...(age !== null ? [[t("people.age"), String(age)] as [string, string]] : []),
  ];

  return (
    <>
      {details.length > 0 && (
        <Section title={t("people.details")}>
          <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-sm dark:text-neutral-100 sm:grid-cols-[8rem_1fr]">
            {details.map(([label, value]) => (
              <Fragment key={label}>
                <dt className="text-neutral-500">{label}</dt>
                <dd>{value}</dd>
              </Fragment>
            ))}
          </dl>
        </Section>
      )}

      {emails.length > 0 && (
        <Section title={t("people.email")}>
          <ValueList rows={emails} onOpen={(v) => void openUrl(`mailto:${v}`)} icon={<Mail size={14} />} />
        </Section>
      )}

      {phones.length > 0 && (
        <Section title={t("people.phone")}>
          <ValueList rows={phones} onOpen={(v) => void openUrl(`tel:${v.replace(/\s+/g, "")}`)} icon={<Phone size={14} />} />
        </Section>
      )}

      {urls.length > 0 && (
        <Section title={t("people.websites")}>
          <ValueList
            rows={urls}
            onOpen={(v) => void openUrl(/^https?:\/\//i.test(v) ? v : `https://${v}`)}
            icon={<ExternalLink size={14} />}
          />
        </Section>
      )}

      {addresses.length > 0 && (
        <Section title={t("people.addresses")}>
          <div className="space-y-2 text-sm dark:text-neutral-100">
            {addresses.map((a, i) => (
              <div key={i}>
                <div className="text-xs text-neutral-500">{t(`people.typeValue.${a.type}`, { defaultValue: a.type ?? "" })}</div>
                <div className="whitespace-pre-line">{formatAddress(a)}</div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {custom.length > 0 && (
        <Section title={t("people.customFields")}>
          <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-sm dark:text-neutral-100 sm:grid-cols-[8rem_1fr]">
            {custom.map((c, i) => (
              <Fragment key={i}>
                <dt className="text-neutral-500">{c.label}</dt>
                <dd>{c.value}</dd>
              </Fragment>
            ))}
          </dl>
        </Section>
      )}

      {form.notes.trim() && (
        <Section title={t("nav.notes")}>
          <p className="whitespace-pre-wrap text-sm dark:text-neutral-100">{form.notes.trim()}</p>
        </Section>
      )}
    </>
  );
}

/** Read-only counterpart to TypedValueRows: type label + clickable value. */
function ValueList({
  rows, onOpen, icon,
}: {
  rows: { type: string; value: string }[];
  onOpen: (value: string) => void;
  icon: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-1 text-sm">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-xs text-neutral-500">
            {t(`people.typeValue.${r.type}`, { defaultValue: r.type })}
          </span>
          <button
            onClick={() => onOpen(r.value.trim())}
            className="flex min-w-0 items-center gap-1.5 truncate text-blue-600 hover:underline dark:text-blue-400"
            title={t("people.open")}
          >
            <span className="truncate">{r.value}</span>
            <span className="shrink-0 text-neutral-400">{icon}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

// --- reusable field bits ------------------------------------------------------
// `inputBase` has no width, so it composes with flex-1 / w-40 without a
// conflicting w-full winning in the cascade. `inputCls` is the full-width form.
const inputBase =
  "rounded border border-neutral-200 px-2 py-1.5 text-sm outline-none focus:border-blue-400 dark:border-neutral-600 dark:bg-neutral-700";
const inputCls = `w-full ${inputBase}`;
const selectCls =
  "rounded border border-neutral-200 px-2 py-1.5 text-sm dark:border-neutral-600 dark:bg-neutral-700";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

/** Shared editor for emails/phones/urls — a list of {type, value} rows. */
function TypedValueRows({
  rows, typeOptions, placeholder, onChange, onOpen, openIcon,
}: {
  rows: { type: string; value: string }[];
  typeOptions: string[];
  placeholder: string;
  onChange: (rows: { type: string; value: string }[]) => void;
  onOpen: (value: string) => void;
  openIcon: React.ReactNode;
}) {
  const { t } = useTranslation();
  const update = (i: number, p: Partial<{ type: string; value: string }>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  const add = () => onChange([...rows, { type: typeOptions[0], value: "" }]);

  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          <select value={r.type} onChange={(e) => update(i, { type: e.target.value })} className={selectCls}>
            {typeOptions.map((o) => (
              <option key={o} value={o}>{t(`people.typeValue.${o}`, { defaultValue: o })}</option>
            ))}
          </select>
          <input value={r.value} onChange={(e) => update(i, { value: e.target.value })} placeholder={placeholder} className={`flex-1 ${inputBase}`} />
          <button
            onClick={() => r.value.trim() && onOpen(r.value.trim())}
            disabled={!r.value.trim()}
            className="rounded p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-blue-500 disabled:opacity-40 dark:hover:bg-neutral-700"
            title={t("people.open")}
          >{openIcon}</button>
          <button onClick={() => remove(i)} className="rounded p-1.5 text-neutral-400 hover:text-red-500" aria-label={t("people.remove")}><X size={14} /></button>
        </div>
      ))}
      <Button variant="ghost" className="px-1" onClick={add}><span className="flex items-center gap-1"><Plus size={14} /> {t("common.add")}</span></Button>
    </div>
  );
}

function hasAddress(a: PersonAddress): boolean {
  return !!(a.street || a.city || a.region || a.postal_code || a.country);
}

function AddressRows({ rows, onChange }: { rows: PersonAddress[]; onChange: (rows: PersonAddress[]) => void }) {
  const { t } = useTranslation();
  const update = (i: number, p: Partial<PersonAddress>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...p } : r)));
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  const add = () => onChange([...rows, { type: ADDR_TYPES[0] }]);

  return (
    <div className="space-y-2">
      {rows.map((a, i) => (
        <div key={i} className="rounded-lg border border-neutral-200 p-2.5 dark:border-neutral-700">
          <div className="mb-2 flex items-center gap-2">
            <select value={a.type} onChange={(e) => update(i, { type: e.target.value })} className={selectCls}>
              {ADDR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <span className="flex-1" />
            <button onClick={() => remove(i)} className="rounded p-1 text-neutral-400 hover:text-red-500" aria-label={t("people.removeAddress")}><X size={14} /></button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input value={a.street ?? ""} onChange={(e) => update(i, { street: e.target.value })} placeholder={t("people.street")} className={`sm:col-span-2 ${inputCls}`} />
            <input value={a.city ?? ""} onChange={(e) => update(i, { city: e.target.value })} placeholder={t("people.city")} className={inputCls} />
            <input value={a.region ?? ""} onChange={(e) => update(i, { region: e.target.value })} placeholder={t("people.region")} className={inputCls} />
            <input value={a.postal_code ?? ""} onChange={(e) => update(i, { postal_code: e.target.value })} placeholder={t("people.postalCode")} className={inputCls} />
            <input value={a.country ?? ""} onChange={(e) => update(i, { country: e.target.value })} placeholder={t("people.country")} className={inputCls} />
          </div>
        </div>
      ))}
      <Button variant="ghost" className="px-1" onClick={add}><span className="flex items-center gap-1"><Plus size={14} /> {t("people.addAddress")}</span></Button>
    </div>
  );
}

/**
 * Custom fields for a person. The label set is GLOBAL — labels live in the
 * `person_custom_fields` registry and every person shows the same rows; only the
 * VALUE is per-person (stored in this person's custom_fields, keyed by label).
 * Adding/removing/reordering a field affects all people; editing a value does
 * not.
 */
function CustomFields({ values, onChange }: { values: PersonCustomField[]; onChange: (rows: PersonCustomField[]) => void }) {
  const { t } = useTranslation();
  const [defs, setDefs] = useState<CustomFieldDef[]>([]);
  const [adding, setAdding] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  // Field the user asked to remove — drives the "delete for everyone vs. clear
  // here" modal. Deleting the def is destructive across all people, so we never
  // do it from a bare click.
  const [confirmField, setConfirmField] = useState<CustomFieldDef | null>(null);

  const reloadDefs = () => listCustomFields().then(setDefs);

  // On mount, promote any labels this person already has to global fields (so
  // pre-existing / AI-created values still appear), then load the shared list.
  useEffect(() => {
    (async () => {
      for (const v of values) if (v.label.trim()) await ensureCustomField(v.label.trim());
      await reloadDefs();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const valueFor = (label: string) => values.find((v) => v.label === label)?.value ?? "";
  const setValue = (label: string, value: string) =>
    onChange([...values.filter((v) => v.label !== label), { label, value }]);

  async function addField() {
    const label = newLabel.trim();
    setAdding(false);
    setNewLabel("");
    if (!label) return;
    await ensureCustomField(label);
    await reloadDefs();
  }

  // Delete the field globally: drops the shared def and, via the db helper,
  // strips its value from every person. Also clear it from this in-memory draft.
  async function deleteForEveryone(def: CustomFieldDef) {
    setConfirmField(null);
    await deleteCustomFieldDef(def.id);
    onChange(values.filter((v) => v.label !== def.label));
    await reloadDefs();
  }

  // Clear only this person's value. The field (and other people's values) stay.
  function clearForThisPerson(def: CustomFieldDef) {
    setConfirmField(null);
    onChange(values.filter((v) => v.label !== def.label));
  }

  /**
   * Move a field one place. Buttons rather than drag: HTML5 drag doesn't work
   * in WKWebView (see CLAUDE.md), so the grip this used to have moved nothing.
   */
  async function move(index: number, delta: number) {
    const to = index + delta;
    if (to < 0 || to >= defs.length) return;
    const ids = defs.map((d) => d.id);
    const [moved] = ids.splice(index, 1);
    ids.splice(to, 0, moved);
    await reorderCustomFields(ids);
    await reloadDefs();
  }

  return (
    <div className="space-y-1.5">
      {defs.map((def, i) => (
        <div key={def.id} className="flex items-center gap-2">
          <span className="flex shrink-0 flex-col">
            <button
              onClick={() => void move(i, -1)}
              disabled={i === 0}
              className="text-neutral-300 hover:text-blue-500 disabled:opacity-30 disabled:hover:text-neutral-300"
              aria-label={t("common.moveUp")}
              title={t("common.moveUp")}
            ><ChevronUp size={13} /></button>
            <button
              onClick={() => void move(i, 1)}
              disabled={i === defs.length - 1}
              className="text-neutral-300 hover:text-blue-500 disabled:opacity-30 disabled:hover:text-neutral-300"
              aria-label={t("common.moveDown")}
              title={t("common.moveDown")}
            ><ChevronDown size={13} /></button>
          </span>
          {/* 160px of label plus the arrows, a value field and a delete button
              leaves nothing for the value on a phone. */}
          <span className="w-24 shrink-0 truncate text-sm text-neutral-600 dark:text-neutral-300 md:w-40" title={def.label}>{def.label}</span>
          <input value={valueFor(def.label)} onChange={(e) => setValue(def.label, e.target.value)} placeholder={t("people.value")} className={`flex-1 ${inputBase}`} />
          <button onClick={() => setConfirmField(def)} className="rounded p-1.5 text-neutral-400 hover:text-red-500" aria-label={t("people.removeField", { label: def.label })}><X size={14} /></button>
        </div>
      ))}
      {defs.length === 0 && !adding && (
        <p className="text-xs text-neutral-400">{t("people.noCustomFields")}</p>
      )}
      {adding ? (
        <input
          autoFocus
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void addField(); if (e.key === "Escape") { setAdding(false); setNewLabel(""); } }}
          onBlur={() => void addField()}
          placeholder={t("people.newFieldPlaceholder")}
          className={`w-full ${inputBase}`}
        />
      ) : (
        <Button variant="ghost" className="px-1" onClick={() => setAdding(true)}><span className="flex items-center gap-1"><Plus size={14} /> {t("people.addField")}</span></Button>
      )}

      <Modal
        open={confirmField !== null}
        onClose={() => setConfirmField(null)}
        title={t("people.removeFieldTitle")}
        footer={confirmField && (
          <>
            <Button variant="ghost" onClick={() => clearForThisPerson(confirmField)}>{t("people.removeFieldThisPerson")}</Button>
            <Button variant="danger" onClick={() => void deleteForEveryone(confirmField)}>{t("people.removeFieldEveryone")}</Button>
          </>
        )}
      >
        {confirmField && (
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            {t("people.removeFieldBody", { label: confirmField.label })}
          </p>
        )}
      </Modal>
    </div>
  );
}
