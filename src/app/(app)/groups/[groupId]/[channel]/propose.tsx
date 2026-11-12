"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { Detail, RallMessage } from "./parts";

/**
 * #propose a spend, UI only. A plain form (Claude is the conversation; this
 * is the fast way in), then Rall's summary of the proposal with the rules
 * that apply to it, then "Send to vote". Nothing is sent yet.
 */

export interface Recipient {
  id: string;
  name: string;
  /** Shown under the name: "Member" or what they're paid for. */
  note: string;
}

export interface ProposeRules {
  /** The pot today, in whole dollars. A spend over 20% of it is "large". */
  pot: number;
  smallPercent: string;
  largePercent: string;
  votingDays: number;
}

const LARGE_SPEND_SHARE = 0.2; // JfkModule.LARGE_SPEND_PERMILLE = 200
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT = /^\d+(\.\d{1,2})?$/;
const NEW = "new";

interface Draft {
  what: string;
  amount: number;
  recipient: string;
  receipt: { kind: "file"; name: string; preview: string | null } | { kind: "link"; url: string } | null;
}

export function ProposeForm({ recipients, rules }: { recipients: Recipient[]; rules: ProposeRules }) {
  const [what, setWhat] = useState("");
  const [amount, setAmount] = useState("");
  const [recipientId, setRecipientId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [receiptFile, setReceiptFile] = useState<{ name: string; preview: string | null } | null>(null);
  const [receiptLink, setReceiptLink] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<Draft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const summary = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const recipientLabel = useId();

  // Free the image preview when it's replaced or the screen closes.
  useEffect(() => {
    const preview = receiptFile?.preview;
    return () => {
      if (preview) URL.revokeObjectURL(preview);
    };
  }, [receiptFile]);

  // Bring the summary into view when it appears.
  useEffect(() => {
    if (draft) summary.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [draft]);

  const review = (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!what.trim()) next.what = "Say what the money is for.";
    else if (what.trim().length > 80) next.what = "Keep it under 80 characters.";
    if (!AMOUNT.test(amount.trim()) || Number(amount) <= 0) next.amount = "Enter an amount, like 400 or 400.50.";
    else if (Number(amount) > rules.pot) next.amount = `The pot only has USDC ${rules.pot.toLocaleString("en-US")}.`;
    if (!recipientId) next.recipient = "Choose who gets paid.";
    if (recipientId === NEW) {
      if (!newName.trim()) next.newName = "Give them a name the group will recognise.";
      if (!ADDRESS.test(newAddress.trim())) next.newAddress = "A wallet address starts with 0x and has 42 characters.";
    }
    if (receiptLink.trim() && !/^https?:\/\/\S+$/.test(receiptLink.trim())) next.receiptLink = "Paste a full link, starting with https://";
    setErrors(next);
    setNotice(null);
    if (Object.keys(next).length > 0) {
      setDraft(null);
      return;
    }

    const recipient =
      recipientId === NEW
        ? `${newName.trim()} (new, ${newAddress.trim().slice(0, 6)}…${newAddress.trim().slice(-4)})`
        : (recipients.find((r) => r.id === recipientId)?.name ?? "");
    setDraft({
      what: what.trim(),
      amount: Number(amount),
      recipient,
      receipt: receiptFile
        ? { kind: "file", ...receiptFile }
        : receiptLink.trim()
          ? { kind: "link", url: receiptLink.trim() }
          : null,
    });
  };

  const large = draft ? draft.amount > rules.pot * LARGE_SPEND_SHARE : false;

  return (
    <div className="max-w-xl">
      <form onSubmit={review} noValidate className="space-y-6">
        <Field
          label="What's it for?"
          name="what"
          placeholder="Airbnb deposit for December"
          value={what}
          maxLength={80}
          onChange={(event) => {
            setWhat(event.target.value);
            setDraft(null);
          }}
          error={errors.what}
        />

        <Field
          label="How much? (USDC)"
          name="amount"
          inputMode="decimal"
          placeholder="400"
          value={amount}
          onChange={(event) => {
            setAmount(event.target.value.replace(/[^\d.]/g, ""));
            setDraft(null);
          }}
          className="tabular-nums"
          error={errors.amount}
          hint={`In the pot now: USDC ${rules.pot.toLocaleString("en-US")}`}
        />

        <fieldset className="space-y-2" aria-describedby={errors.recipient ? `${recipientLabel}-error` : undefined}>
          <legend id={recipientLabel} className="text-sm font-medium text-ink-muted">
            Who gets paid?
          </legend>
          <div className="flex flex-wrap gap-2">
            {[...recipients, { id: NEW, name: "+ New recipient", note: "" }].map((recipient) => (
              <button
                key={recipient.id}
                type="button"
                aria-pressed={recipientId === recipient.id}
                onClick={() => {
                  // Tapping the chosen one again clears the choice.
                  setRecipientId((current) => (current === recipient.id ? null : recipient.id));
                  setDraft(null);
                }}
                className={cn(
                  "press flex min-h-11 flex-col items-start justify-center rounded-[var(--radius-control)] border px-4 py-2 text-left text-sm transition-colors",
                  recipientId === recipient.id
                    ? "border-accent bg-accent-soft text-ink"
                    : "border-border text-ink-muted hover:border-border-strong hover:text-ink",
                )}
              >
                <span>{recipient.name}</span>
                {recipient.note && <span className="text-xs text-ink-faint">{recipient.note}</span>}
              </button>
            ))}
          </div>
          {errors.recipient && (
            <p id={`${recipientLabel}-error`} role="alert" className="text-sm text-danger">
              {errors.recipient}
            </p>
          )}
        </fieldset>

        {recipientId === NEW && (
          <div className="animate-arrive space-y-4 rounded-[var(--radius-card)] border border-border p-4">
            <Field
              label="Their name"
              name="newName"
              placeholder="Musa, the electrician"
              value={newName}
              onChange={(event) => {
                setNewName(event.target.value);
                setDraft(null);
              }}
              error={errors.newName}
            />
            <Field
              label="Their wallet address on Base"
              name="newAddress"
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
              value={newAddress}
              onChange={(event) => {
                setNewAddress(event.target.value.trim());
                setDraft(null);
              }}
              className="font-mono text-sm"
              error={errors.newAddress}
              hint="Double-check it. Money sent to a wrong address can't be brought back."
            />
          </div>
        )}

        <div className="space-y-2">
          <p className="text-sm font-medium text-ink-muted">
            Receipt <span className="text-ink-faint">(optional)</span>
          </p>
          <p className="text-sm text-ink-faint">An invoice, a quote or a listing helps everyone vote with confidence.</p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInput}
              type="file"
              accept="image/*,application/pdf"
              className="sr-only"
              aria-label="Attach a receipt"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                setReceiptFile({
                  name: file.name,
                  preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
                });
                setDraft(null);
              }}
            />
            {receiptFile ? (
              <span className="flex items-center gap-3 rounded-[var(--radius-control)] border border-border py-1.5 pr-2 pl-1.5 text-sm">
                {receiptFile.preview ? (
                  // A local preview of the user's own file, not a remote image.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={receiptFile.preview} alt="" className="size-9 rounded-[6px] object-cover" />
                ) : (
                  <span aria-hidden="true" className="grid size-9 place-items-center rounded-[6px] bg-raised text-[0.625rem] font-semibold text-ink-muted">
                    PDF
                  </span>
                )}
                <span className="max-w-48 truncate text-ink">{receiptFile.name}</span>
                <button
                  type="button"
                  onClick={() => {
                    setReceiptFile(null);
                    if (fileInput.current) fileInput.current.value = "";
                    setDraft(null);
                  }}
                  aria-label="Remove the receipt"
                  className="press grid size-8 place-items-center rounded-[6px] text-ink-muted hover:bg-raised hover:text-ink"
                >
                  <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round">
                    <path d="M4 4l8 8M12 4l-8 8" />
                  </svg>
                </button>
              </span>
            ) : (
              <Button type="button" variant="secondary" size="sm" onClick={() => fileInput.current?.click()}>
                Attach a photo or PDF
              </Button>
            )}
          </div>
          {!receiptFile && (
            <Field
              label="Or paste a link"
              name="receiptLink"
              placeholder="https://"
              inputMode="url"
              value={receiptLink}
              onChange={(event) => {
                setReceiptLink(event.target.value);
                setDraft(null);
              }}
              error={errors.receiptLink}
            />
          )}
        </div>

        <div className="space-y-3">
          <Button type="submit">Review proposal</Button>
          <p className="text-sm text-ink-faint">
            Or ask Claude: <span className="text-ink-muted">&ldquo;Propose USDC 400 for the Airbnb deposit, paid to Kemi.&rdquo;</span>
          </p>
        </div>
      </form>

      {draft && (
        <div ref={summary} className="animate-arrive mt-8">
          <RallMessage
            sentAt={new Date()}
            time="Just now"
            footnote={
              <div className="space-y-3 border-t border-border pt-4">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => setNotice("Sending to a vote comes in a later step. Nothing was sent.")}
                  >
                    Send to vote
                  </Button>
                  <Button type="button" variant="secondary" size="sm" onClick={() => setDraft(null)}>
                    Change something
                  </Button>
                </div>
                {notice && (
                  <p role="status" className="text-xs text-ink-muted">
                    {notice}
                  </p>
                )}
              </div>
            }
          >
            <Detail label="For">{draft.what}</Detail>
            <Detail label="Amount">
              <span className="tabular-nums">USDC {draft.amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span>
            </Detail>
            <Detail label="Paid to">{draft.recipient}</Detail>
            {draft.receipt && (
              <Detail label="Receipt">
                {draft.receipt.kind === "file" ? (
                  <ReceiptChip name={draft.receipt.name} preview={draft.receipt.preview} />
                ) : (
                  <a
                    href={draft.receipt.url}
                    target="_blank"
                    rel="noreferrer"
                    className="break-all underline decoration-ink-faint underline-offset-4 hover:decoration-ink"
                  >
                    {draft.receipt.url}
                  </a>
                )}
              </Detail>
            )}
            <Detail label="To pass">
              {large ? "A large spend" : "A small spend"}
              <span className="text-ink-muted"> · {large ? rules.largePercent : rules.smallPercent} must agree</span>
            </Detail>
            <Detail label="Voting">Closes {rules.votingDays} days after it&rsquo;s sent</Detail>
          </RallMessage>
        </div>
      )}
    </div>
  );
}

function ReceiptChip({ name, preview }: { name: string; preview: string | null }): ReactNode {
  return (
    <span className="inline-flex items-center gap-2">
      {preview ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={preview} alt="" className="size-8 rounded-[6px] object-cover" />
      ) : (
        <span aria-hidden="true" className="grid size-8 place-items-center rounded-[6px] bg-overlay text-[0.625rem] font-semibold text-ink-muted">
          PDF
        </span>
      )}
      <span className="truncate">{name}</span>
    </span>
  );
}
