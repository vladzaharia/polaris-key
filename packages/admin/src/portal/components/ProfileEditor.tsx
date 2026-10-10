import * as React from "react";
import { Check, Info, Upload } from "lucide-react";
import { Button } from "../../ui/Button.js";
import { Input } from "../../ui/Input.js";
import { announce } from "../../ui/LiveRegion.js";
import { Spinner } from "../../ui/Spinner.js";
import { cn } from "../../lib/cn.js";
import {
  PortalApiError,
  type PortalAccount,
  type PortalAvatar,
  type PortalProfile,
} from "../api.js";
import {
  chipLabel,
  earlierPictureNote,
  nameFollowsHint,
  namePickedHint,
  nameTypedHint,
  PROFILE_COPY as C,
} from "../copy/profile.js";
import { useUpdateProfile, useUploadPicture } from "../data.js";
import {
  badgeProvider,
  BIRTHDATE_MIN,
  currentPictureOrigin,
  draftBirthdate,
  draftName,
  draftNameSource,
  draftPicture,
  NO_DRAFT,
  nameInvalid,
  nameOptions,
  nameProviders,
  pickName,
  pickTile,
  pictureOptions,
  profileChange,
  profileErrorCopy,
  providerName,
  reconcileDraft,
  selectedTile,
  tileInUse,
  todayIso,
  UPLOAD_MAX_BYTES,
  UPLOAD_TYPES,
  type PictureTile,
  type ProfileDraft,
} from "../model/profile.js";
import { Avatar } from "./Avatar.js";
import { ProviderGlyph, providerBadge } from "./Glyphs.js";

type FieldError = {
  field: "name" | "picture" | "birthdate" | "form";
  text: string;
} | null;

/**
 * Account → Profile, editing (PORTAL.md §4.30, frame 50; PX-22): a preview, the screen name with
 * a **Your choice** tag once typed and chips for each method's name, the picture as radio tiles
 * (each method's picture, an upload, Initials) with **In use** on the saved one, an **Upload**
 * tile, and the optional birth date (I-33), private to the person. Saving sends only what the
 * person chose (`model/profile.ts`), so imported values they left alone keep following their
 * provider and every choice sticks.
 */
export function ProfileEditor({
  profile,
  account,
  focus = "name",
  onDone,
}: {
  profile: PortalProfile;
  account: PortalAccount;
  /** Where focus starts: the name field, or the picture (from "Add a picture"). */
  focus?: "name" | "picture";
  /** `saved` is true when a change was saved, false for Cancel or nothing to save. */
  onDone: (saved: boolean) => void;
}): React.ReactElement {
  const [draft, setDraft] = React.useState<ProfileDraft>(NO_DRAFT);
  /** A picture uploaded during this edit (unused until saved). */
  const [upload, setUpload] = React.useState<PortalAvatar | null>(null);
  const [error, setError] = React.useState<FieldError>(null);
  const save = useUpdateProfile();
  const up = useUploadPicture();
  const nameRef = React.useRef<HTMLInputElement>(null);
  const pictureRef = React.useRef<HTMLFieldSetElement>(null);
  const uploadRef = React.useRef<HTMLButtonElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const birthRef = React.useRef<HTMLInputElement>(null);
  const id = React.useId();

  React.useEffect(() => {
    if (focus === "name") {
      nameRef.current?.focus();
      return;
    }
    // "Add a picture": the selected picture when a method supplied one, else Upload.
    const checked = pictureOptions(profile).length
      ? pictureRef.current?.querySelector<HTMLInputElement>(
          "input[type=radio]:checked",
        )
      : null;
    (checked ?? uploadRef.current)?.focus();
    // Once, as the editor opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const name = draftName(profile, draft, account.name);
  const nameSrc = draftNameSource(profile, draft);
  const yourChoice = nameSrc.source?.kind === "typed";
  const pic = draftPicture(profile, draft);
  const selected = selectedTile(profile, draft);
  const inUse = tileInUse(profile);
  const names = nameOptions(profile);
  const providers = nameProviders(profile);
  const birthdate = draftBirthdate(profile, draft);

  let hint: string | null = null;
  if (yourChoice) hint = nameTypedHint(providers);
  else if (nameSrc.source?.kind === "provider") {
    const p = providerName(nameSrc.source.provider);
    if (p) hint = nameSrc.explicit ? namePickedHint(p) : nameFollowsHint(p);
  }

  const savedUpload =
    profile.pictureSource?.kind === "upload" ? profile.picture : null;
  const uploadTile = upload ?? savedUpload;
  const tiles: TileSpec[] = [
    ...pictureOptions(profile).map((o) => ({
      id: `link:${o.linkId}` as PictureTile,
      title: providerName(o.provider) ?? o.label ?? "",
      note: o.label,
      picture: o.picture.url,
    })),
    ...(uploadTile
      ? [
          {
            id: "upload" as const,
            title: C["profile.picture.yourUpload"],
            note: C["profile.picture.yourUploadNote"],
            picture: uploadTile.url,
          },
        ]
      : []),
    ...(inUse === "current"
      ? [
          {
            id: "current" as const,
            title: C["profile.picture.current"],
            note: currentNote(currentPictureOrigin(profile)),
            picture: profile.picture?.url ?? null,
          },
        ]
      : []),
    {
      id: "initials",
      title: C["profile.picture.initials"],
      note: C["profile.picture.initialsNote"],
      picture: null,
    },
  ];

  // A refused save re-reads the profile (`useUpdateProfile`): drop the choices whose source
  // went away, so the field and the tiles show what is there now.
  React.useEffect(() => {
    setDraft((d) => reconcileDraft(profile, d));
  }, [profile]);

  const typeName = (value: string): void => {
    setDraft((d) => ({ ...d, name: { kind: "typed", value } }));
    if (error?.field === "name") setError(null);
  };

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    // The Worker judges by the bytes; these only spare an upload (and the hourly budget) that
    // is sure to be refused.
    if (file.size > UPLOAD_MAX_BYTES)
      return setError({ field: "picture", text: C["profile.error.tooLarge"] });
    if (file.type && !UPLOAD_TYPES.includes(file.type))
      return setError({
        field: "picture",
        text: C["profile.error.unsupportedType"],
      });
    setError(null);
    up.mutate(file, {
      onSuccess: ({ upload: done }) => {
        setUpload(done);
        setDraft((d) => ({
          ...d,
          picture: { kind: "upload", picture: done },
        }));
        announce(C["profile.picture.uploaded"]);
      },
      onError: (err) =>
        setError({ field: "picture", text: profileErrorCopy(err, "upload") }),
    });
  };

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    if (up.isPending || save.isPending) return;
    if (nameInvalid(draft)) {
      setError({ field: "name", text: C["profile.name.required"] });
      nameRef.current?.focus();
      return;
    }
    // A half-typed date reads as empty to script; the browser knows it is not one.
    if (birthRef.current && !birthRef.current.validity.valid) {
      setError({
        field: "birthdate",
        text: C["profile.error.invalidBirthdate"],
      });
      birthRef.current.focus();
      return;
    }
    const change = profileChange(profile, draft);
    if (!change) return onDone(false);
    save.mutate(change, {
      onSuccess: () => onDone(true),
      onError: (err) => {
        const reason = err instanceof PortalApiError ? err.reason : undefined;
        if (reason === "unknown_upload") {
          // The upload was collected: it can't be picked anymore, so it leaves the tiles.
          setUpload(null);
          setDraft((d) =>
            d.picture?.kind === "upload" ? { ...d, picture: null } : d,
          );
        }
        const field = reason ? fieldOf(reason, change) : "form";
        setError({ field, text: profileErrorCopy(err, "save") });
        if (field === "name") nameRef.current?.focus();
        if (field === "birthdate") birthRef.current?.focus();
      },
    });
  };

  const typeBirthdate = (value: string): void => {
    setDraft((d) => ({ ...d, birthdate: { kind: "typed", value } }));
    if (error?.field === "birthdate") setError(null);
  };

  const removeBirthdate = (): void => {
    setDraft((d) => ({ ...d, birthdate: { kind: "removed" } }));
    if (error?.field === "birthdate") setError(null);
    // The button leaves with the date: focus goes to the field it emptied.
    requestAnimationFrame(() => birthRef.current?.focus());
  };

  const nameErrId = `${id}-name-err`;
  const hintId = `${id}-name-hint`;
  const pictureErrId = `${id}-picture-err`;
  const uploadNoteId = `${id}-upload-note`;
  const birthErrId = `${id}-birthdate-err`;
  const birthHintId = `${id}-birthdate-hint`;
  const badge = badgeProvider(pic.picture, pic.source, nameSrc.source);

  return (
    <form noValidate onSubmit={submit} className="@container">
      <div className="grid gap-5 @3xl:grid-cols-[11rem_minmax(0,1fr)]">
        {/* The preview: the picture as it will look, with its source badge, and the name. */}
        <div
          data-profile-preview
          className="flex min-w-0 items-center gap-4 self-start rounded-lg border border-border bg-surface-page p-4 @3xl:flex-col @3xl:text-center"
        >
          {[56, 96].map((size) => (
            <Avatar
              key={size}
              name={name}
              email={account.email}
              picture={pic.picture?.url ?? null}
              size={size as 56 | 96}
              badge={providerBadge(badge)}
              className={
                size === 56 ? "@3xl:hidden" : "hidden @3xl:inline-flex"
              }
            />
          ))}
          <div className="min-w-0">
            <p className="font-bold text-fg-strong [overflow-wrap:anywhere]">
              {name.trim() || account.email}
            </p>
            <p className="text-xs text-fg-muted">{C["profile.preview"]}</p>
          </div>
        </div>

        <div className="min-w-0 space-y-5">
          <div className="space-y-2">
            <label
              htmlFor={`${id}-name`}
              className="text-sm font-bold text-fg-strong"
            >
              {C["profile.name.label"]}
            </label>
            <Input
              ref={nameRef}
              id={`${id}-name`}
              value={name}
              maxLength={64}
              autoComplete="nickname"
              spellCheck={false}
              aria-invalid={error?.field === "name" ? true : undefined}
              aria-describedby={
                [
                  error?.field === "name" ? nameErrId : null,
                  hint ? hintId : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              onValueChange={typeName}
              // Always framed, so the input is not re-mounted (and focus lost) as the tag appears.
              suffix={<YourChoiceTag show={yourChoice} />}
            />
            {error?.field === "name" ? (
              <p id={nameErrId} role="alert" className="text-sm text-danger">
                {error.text}
              </p>
            ) : null}
            {names.length ? (
              <div className="flex flex-wrap items-center gap-2">
                <span id={`${id}-chips`} className="text-sm text-fg-muted">
                  {C["profile.name.useFrom"]}
                </span>
                <ul
                  aria-labelledby={`${id}-chips`}
                  className="flex flex-wrap gap-2"
                >
                  {names.map((o) => {
                    const p = providerName(o.provider) ?? o.label ?? "";
                    const on =
                      nameSrc.source?.kind === "provider" &&
                      nameSrc.source.linkId === o.linkId &&
                      name === o.name;
                    return (
                      <li key={o.linkId}>
                        <button
                          type="button"
                          aria-pressed={on}
                          aria-label={chipLabel(p, o.name)}
                          onClick={() => {
                            setDraft((d) => ({
                              ...d,
                              name: pickName(profile, o.linkId),
                            }));
                            if (error?.field === "name") setError(null);
                          }}
                          className={cn(
                            "pk-pressable inline-flex h-9 max-w-full items-center gap-1.5 rounded-full border px-3 text-sm pointer-coarse:h-11",
                            "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page",
                            on
                              ? "border-accent bg-accent-subtle font-bold text-fg-strong"
                              : "border-border-strong text-fg hover:bg-hover hover:text-fg-strong",
                          )}
                        >
                          <ProviderGlyph
                            provider={o.provider}
                            className="size-4 shrink-0"
                          />
                          <span className="truncate">{o.name}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            {hint ? (
              <p id={hintId} className="text-sm text-fg-muted">
                {hint}
              </p>
            ) : null}
          </div>

          <fieldset
            ref={pictureRef}
            aria-describedby={
              error?.field === "picture" ? pictureErrId : undefined
            }
            className="min-w-0"
          >
            <legend className="mb-2 text-sm font-bold text-fg-strong">
              {C["profile.picture.label"]}
            </legend>
            <div className="grid grid-cols-2 gap-3 @md:grid-cols-4">
              {tiles.map((t) => (
                <PictureTileRadio
                  key={t.id}
                  group={`${id}-picture`}
                  tile={t}
                  initialsName={name}
                  email={account.email}
                  checked={selected === t.id}
                  inUse={inUse === t.id}
                  onPick={() => {
                    setDraft((d) => ({
                      ...d,
                      picture: pickTile(profile, t.id, upload),
                    }));
                    if (error?.field === "picture") setError(null);
                  }}
                />
              ))}
              <button
                ref={uploadRef}
                type="button"
                aria-labelledby={`${id}-upload`}
                aria-describedby={uploadNoteId}
                aria-disabled={up.isPending || undefined}
                aria-busy={up.isPending || undefined}
                onClick={() => {
                  if (!up.isPending) fileRef.current?.click();
                }}
                className={cn(
                  "pk-pressable flex min-h-36 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border-strong p-3 text-center hover:bg-hover",
                  "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-surface-page",
                )}
              >
                <span
                  aria-hidden
                  className="inline-flex size-12 items-center justify-center rounded-full border border-border text-fg-strong"
                >
                  {up.isPending ? (
                    <Spinner label="" />
                  ) : (
                    <Upload className="size-5" />
                  )}
                </span>
                <span
                  id={`${id}-upload`}
                  className="text-sm font-bold text-fg-strong"
                >
                  {up.isPending
                    ? C["profile.picture.uploading"]
                    : C["profile.picture.upload"]}
                </span>
                <span id={uploadNoteId} className="text-xs text-fg-muted">
                  {C["profile.picture.uploadNote"]}
                </span>
              </button>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg"
              tabIndex={-1}
              aria-hidden
              hidden
              onChange={pickFile}
            />
            {error?.field === "picture" ? (
              <p
                id={pictureErrId}
                role="alert"
                className="mt-2 text-sm text-danger"
              >
                {error.text}
              </p>
            ) : null}
          </fieldset>

          <div className="space-y-2">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <label
                htmlFor={`${id}-birthdate`}
                className="text-sm font-bold text-fg-strong"
              >
                {C["profile.birthdate.label"]}
              </label>
              <span className="text-xs text-fg-muted">
                {C["profile.birthdate.optional"]}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                ref={birthRef}
                id={`${id}-birthdate`}
                type="date"
                value={birthdate}
                min={BIRTHDATE_MIN}
                max={todayIso()}
                autoComplete="bday"
                aria-invalid={error?.field === "birthdate" ? true : undefined}
                aria-describedby={
                  error?.field === "birthdate"
                    ? `${birthErrId} ${birthHintId}`
                    : birthHintId
                }
                onValueChange={typeBirthdate}
                className="w-full max-w-56"
              />
              {birthdate ? (
                <Button variant="ghost" onClick={removeBirthdate}>
                  {C["profile.birthdate.remove"]}
                </Button>
              ) : null}
            </div>
            {error?.field === "birthdate" ? (
              <p id={birthErrId} role="alert" className="text-sm text-danger">
                {error.text}
              </p>
            ) : null}
            <p id={birthHintId} className="text-sm text-fg-muted">
              {C["profile.birthdate.hint"]}
            </p>
          </div>

          <p className="flex gap-2 text-sm text-fg-muted">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            <span>{C["profile.note"]}</span>
          </p>

          {error?.field === "form" ? (
            <p role="alert" className="text-sm text-danger">
              {error.text}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" loading={save.isPending}>
              {C["profile.save"]}
            </Button>
            <Button variant="outline" onClick={() => onDone(false)}>
              {C["profile.cancel"]}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

/** The note under the in-use picture's own tile: why it is not a method's current picture. */
function currentNote(
  origin: ReturnType<typeof currentPictureOrigin>,
): string | null {
  if (origin.removed) return C["profile.picture.currentNote"];
  return origin.provider ? earlierPictureNote(origin.provider) : null;
}

/** Which field a save refusal belongs to (the Worker's `reason`). */
function fieldOf(
  reason: string,
  change: { nameFrom?: string; picture?: unknown },
): "name" | "picture" | "birthdate" | "form" {
  if (reason === "invalid_birthdate") return "birthdate";
  if (reason === "invalid_name" || reason === "no_name") return "name";
  if (reason === "no_picture" || reason === "unknown_upload") return "picture";
  if (reason === "unknown_source") {
    if (
      change.picture &&
      typeof change.picture === "object" &&
      "from" in change.picture
    )
      return change.nameFrom ? "form" : "picture";
    return change.nameFrom ? "name" : "form";
  }
  return "form";
}

function YourChoiceTag({ show }: { show: boolean }): React.ReactElement {
  return (
    <span
      hidden={!show}
      className="inline-flex h-6 items-center rounded-full bg-accent-subtle px-2 text-xs font-bold text-accent-fg"
    >
      {C["profile.name.yourChoice"]}
    </span>
  );
}

interface TileSpec {
  id: PictureTile;
  title: string;
  note: string | null;
  picture: string | null;
}

/**
 * One picture choice: a native radio (one tab stop, arrows move and select) in a tile. The
 * selected tile carries the accent edge, the tint and a check, never colour alone; the saved one
 * says **In use**.
 */
function PictureTileRadio({
  group,
  tile,
  initialsName,
  email,
  checked,
  inUse,
  onPick,
}: {
  group: string;
  tile: TileSpec;
  initialsName: string;
  email: string;
  checked: boolean;
  inUse: boolean;
  onPick: () => void;
}): React.ReactElement {
  return (
    <label
      data-tile={tile.id}
      className={cn(
        "group pk-pressable relative flex min-h-36 min-w-0 cursor-pointer flex-col items-center gap-1 rounded-lg border border-border bg-surface-raised p-3 text-center hover:border-border-strong",
        "has-[:checked]:border-accent has-[:checked]:bg-accent-subtle",
        "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus has-[:focus-visible]:ring-offset-2 has-[:focus-visible]:ring-offset-surface-page",
      )}
    >
      <input
        type="radio"
        name={group}
        value={tile.id}
        checked={checked}
        onChange={onPick}
        // A checked radio fires no change; picking it again still counts (it pins a followed
        // picture, `pickTile`).
        onClick={() => {
          if (checked) onPick();
        }}
        className="sr-only"
      />
      <Check
        aria-hidden
        className="absolute right-2 top-2 hidden size-4 text-accent-fg group-has-[:checked]:block"
      />
      <Avatar
        name={initialsName}
        email={email}
        picture={tile.picture}
        size={48}
        className="mb-1"
      />
      <span className="max-w-full text-sm font-bold text-fg-strong [overflow-wrap:anywhere]">
        {tile.title}
      </span>
      {tile.note ? (
        <span className="max-w-full text-xs text-fg-muted [overflow-wrap:anywhere]">
          {tile.note}
        </span>
      ) : null}
      {inUse ? (
        <span className="mt-1 inline-flex h-5 items-center rounded-full border border-border px-2 text-xs font-bold text-fg-strong">
          {C["profile.picture.inUse"]}
        </span>
      ) : null}
    </label>
  );
}
