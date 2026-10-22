/** The listing editor's Release notes tab (A-27.10; moved out of ListingEditor.tsx). */

import * as React from "react";
import type { ListingResponse } from "../../../../../api.js";
import { Button } from "../../../../../ui/Button.js";
import { EmptyState } from "../../../../../ui/EmptyState.js";
import { ErrorState } from "../../../../../ui/ErrorState.js";
import { Select } from "../../../../../ui/Select.js";
import { Skeleton } from "../../../../../ui/Skeleton.js";
import { Textarea } from "../../../../../ui/Textarea.js";
import { toast } from "../../../../../ui/toast.js";
import { mutate } from "../../../../data/mutations.js";
import { useSearchParam } from "../../../../router.js";
import { codecs } from "../../../../routes.js";
import {
  SettingsRow,
  SettingsSection,
} from "../../../../templates/Settings.js";
import { useReleaseStore } from "../../../distribution/data.js";
import { useReleaseNotes } from "../../../storefronts/data.js";
import { docsUrl } from "../../../../../lib/docsLinks.js";

// ── Release notes ────────────────────────────────────────────────────────────────────────────

const releaseCodec = codecs.string("");

export function NotesTab({
  slug,
  data,
}: {
  slug: string;
  data: ListingResponse;
}): React.ReactElement {
  const releases = useReleaseStore(slug);
  const [releaseRaw, setRelease] = useSearchParam("release", releaseCodec);
  const list = (releases.data?.releases ?? []).filter(
    (x) => x.deliverable === "app",
  );
  const release = releaseRaw || list[0]?.releaseId || "";
  const notes = useReleaseNotes(slug, release || null);
  if (releases.isPending) return <Skeleton className="h-48 w-full" />;
  if (list.length === 0)
    return (
      <EmptyState
        kind="first-run"
        headingLevel={2}
        title="No releases yet"
        description="Each release's store notes are edited here once it is published."
        docs={docsUrl("storefrontListing")}
      />
    );
  return (
    <SettingsSection
      id="listing-notes"
      title="Store notes"
      actions={
        <Select
          aria-label="Release"
          options={list.map((x) => ({ value: x.releaseId, label: x.version }))}
          value={release}
          onChange={(v) => v && setRelease(v)}
        />
      }
    >
      {notes.isPending ? (
        <div className="p-5">
          <Skeleton className="h-24 w-full" />
        </div>
      ) : notes.isError ? (
        <div className="p-5">
          <ErrorState
            error={notes.error}
            onRetry={() => void notes.refetch()}
            context={{ area: "distribution", thing: "Release notes" }}
          />
        </div>
      ) : (
        [
          ...notes.data.notes.locales,
          ...data.locales
            .map((l) => l.locale)
            .filter(
              (l) => !notes.data.notes.locales.some((n) => n.locale === l),
            )
            .map((l) => ({
              locale: l,
              text: "",
              short: null,
              source: "none",
              proposedShort: null,
              modifiedAt: null,
              modifiedBy: null,
            })),
        ].map((n) => (
          <NoteRow
            key={`${release}:${n.locale}`}
            slug={slug}
            release={release}
            note={n}
            limits={notes.data.limits}
          />
        ))
      )}
    </SettingsSection>
  );
}

function NoteRow({
  slug,
  release,
  note,
  limits,
}: {
  slug: string;
  release: string;
  note: {
    locale: string;
    text: string;
    short: string | null;
    source: string;
    proposedShort: string | null;
  };
  limits: { short: number; text: number };
}): React.ReactElement {
  const [text, setText] = React.useState(note.text);
  const [short, setShort] = React.useState(note.short ?? "");
  const [busy, setBusy] = React.useState(false);
  const dirty = text !== note.text || short !== (note.short ?? "");
  const save = async () => {
    setBusy(true);
    try {
      await mutate("putListingReleaseNotes", slug, release, {
        locale: note.locale,
        text: text.trim() === "" ? null : text,
        short: short.trim() === "" ? null : short,
      });
      toast.success(`Notes saved for ${note.locale}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      label={note.locale}
      help={
        note.source === "default"
          ? "From the release's own notes until you save it."
          : `Up to ${limits.text} characters; the short form, for Google Play and F-Droid, up to ${limits.short}.`
      }
      align="stretch"
    >
      <div className="space-y-2">
        <Textarea
          aria-label={`Notes in ${note.locale}`}
          value={text}
          onValueChange={setText}
          maxLength={limits.text}
        />
        <Textarea
          aria-label={`Short notes in ${note.locale}`}
          value={short}
          placeholder={note.proposedShort ?? undefined}
          onValueChange={setShort}
          maxLength={limits.short}
        />
        <div className="flex justify-end gap-2">
          {note.proposedShort && short === "" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShort(note.proposedShort!)}
            >
              Use the proposed short form
            </Button>
          ) : null}
          <Button
            size="sm"
            disabled={!dirty}
            loading={busy}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </div>
    </SettingsRow>
  );
}
