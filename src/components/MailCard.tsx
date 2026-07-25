// One clickable row for an email, shared by global search results and the
// assistant's chat cards, so the two never drift in look or behaviour.
//
// Unlike ItemCard this takes the whole MailMessageSummary, not an identity to
// reload: mail has no local row, so the summary a search or a read already
// fetched is the freshest thing there is — and it is exactly what NavTarget.mail
// carries into the Mail reader when the row is clicked.

import { Mail } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MailAddress, MailMessageSummary } from "../lib/mail";
import { fmtDateTime } from "../lib/format";

function senderLabel(from: MailAddress[]): string {
  const first = from[0];
  if (!first) return "";
  return first.name ?? first.address;
}

export function MailCard({ msg, onClick }: { msg: MailMessageSummary; onClick?: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg border border-neutral-200 px-3 py-2 text-left hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
    >
      <Mail size={18} className="shrink-0 text-neutral-500" />
      <span className="flex-1 min-w-0">
        <span className="block truncate font-medium">{msg.subject || t("common.untitled")}</span>
        <span className="block truncate text-xs text-neutral-400">
          {[senderLabel(msg.from), msg.date ? fmtDateTime(msg.date) : ""].filter(Boolean).join(" · ")}
        </span>
      </span>
      <span className="shrink-0 text-xs text-neutral-400">{t("itemType.email")}</span>
    </button>
  );
}
