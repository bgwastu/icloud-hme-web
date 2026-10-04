import { useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Button,
  CopyButton,
  Group,
  Loader,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import { IconCheck, IconCopy, IconTrash } from "@tabler/icons-react";
import type { Alias, Snapshot } from "../shared/types";
import { api, mutation, type MutationResult } from "./api";
export interface AddressDraft {
  base: Alias;
  label: string;
  note: string;
}
export function AddressEditor({
  alias,
  deleting,
  busy,
  blocked,
  drafts,
  run,
  update,
  accept,
  openDelete,
  cancelDelete,
  deleted,
}: {
  alias: Alias;
  deleting: boolean;
  busy: boolean;
  blocked: boolean;
  drafts: Map<string, AddressDraft>;
  run: (task: () => Promise<void>) => Promise<void>;
  update: (snapshot: Snapshot) => void;
  accept: (result: MutationResult) => void;
  openDelete: () => void;
  cancelDelete: () => void;
  deleted: () => void;
}) {
  const [draft, setDraft] = useState<AddressDraft>(
    () =>
      drafts.get(alias.id) ?? {
        base: alias,
        label: alias.label,
        note: alias.note ?? "",
      },
  );
  const [checking, setChecking] = useState(true);
  const [changingActivation, setChangingActivation] = useState(false);
  const [noteReadable, setNoteReadable] = useState(false);
  const [confirm, setConfirm] = useState("");
  const deleteButton = useRef<HTMLButtonElement>(null),
    confirmInput = useRef<HTMLInputElement>(null);
  const wasDeleting = useRef(deleting);
  const dirty =
    draft.label !== draft.base.label || draft.note !== (draft.base.note ?? "");
  const conflict =
    dirty && alias.version !== draft.base.version && alias.note !== null;
  useEffect(() => {
    drafts.set(alias.id, draft);
  }, [alias.id, draft, drafts]);
  useEffect(() => {
    if (!dirty && alias.version !== draft.base.version)
      setDraft({ base: alias, label: alias.label, note: alias.note ?? "" });
  }, [alias, dirty, draft.base.version]);
  useEffect(() => {
    let active = true;
    void run(async () => {
      const { alias: fresh } = await api<{ alias: Alias }>(
        `/aliases/${encodeURIComponent(alias.id)}`,
      );
      const snapshot = await api<Snapshot>("/aliases");
      if (active) update(snapshot);
      if (active) setNoteReadable(fresh.note !== null);
      if (active)
        setDraft((current) =>
          current.label !== current.base.label ||
          current.note !== (current.base.note ?? "")
            ? current
            : { base: fresh, label: fresh.label, note: fresh.note ?? "" },
        );
    }).finally(() => {
      if (active) setChecking(false);
    });
    return () => {
      active = false;
    };
    // Read once per opening; background sync never replaces an unsaved draft.
  }, [alias.id, run]);
  useEffect(() => {
    if (deleting) {
      setConfirm("");
      confirmInput.current?.focus();
    } else if (wasDeleting.current) deleteButton.current?.focus();
    wasDeleting.current = deleting;
  }, [deleting]);
  if (deleting)
    return (
      <form
        className="editor"
        onSubmit={(event) => {
          event.preventDefault();
          if (confirm !== alias.email) return;
          void run(async () => {
            accept(
              await mutation(
                `/aliases/${encodeURIComponent(alias.id)}`,
                "DELETE",
                { confirmEmail: confirm },
              ),
            );
            drafts.delete(alias.id);
            deleted();
          });
        }}
      >
        <Text mb="lg">
          This address will stop receiving email. Deletion is permanent.
        </Text>
        <Text className="delete-address" fw={600} mb="lg">
          {alias.email}
        </Text>
        <TextInput
          ref={confirmInput}
          label="Type the address to confirm"
          value={confirm}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          onChange={(event) => setConfirm(event.currentTarget.value)}
          disabled={busy}
        />
        <Group justify="space-between" className="modal-footer">
          <Button variant="default" disabled={busy} onClick={cancelDelete}>
            Cancel
          </Button>
          <Button
            color="red"
            type="submit"
            loading={busy}
            disabled={blocked || confirm !== alias.email}
          >
            Delete permanently
          </Button>
        </Group>
      </form>
    );
  return (
    <div className="editor">
      <div className="address-summary">
        <Text fw={600} className="address-email">
          {alias.email}
        </Text>
        <CopyButton value={alias.email}>
          {({ copied, copy }) => (
            <ActionIcon
              color={copied ? "green" : "gray"}
              onClick={copy}
              aria-label="Copy address"
            >
              {copied ? <IconCheck size={19} /> : <IconCopy size={19} />}
            </ActionIcon>
          )}
        </CopyButton>
      </div>
      {conflict && (
        <Alert color="yellow" title="Changed in iCloud" mb="lg">
          <Text size="sm">
            Your edits are kept. Review the current version:
          </Text>
          <Text fw={600} mt="xs">
            {alias.label}
          </Text>
          <Text className="current-note" size="sm">
            {alias.note || "No notes"}
          </Text>
          <Button
            variant="light"
            size="sm"
            mt="sm"
            onClick={() =>
              setDraft({
                base: alias,
                label:
                  draft.label === draft.base.label ? alias.label : draft.label,
                note:
                  draft.note === (draft.base.note ?? "")
                    ? (alias.note ?? "")
                    : draft.note,
              })
            }
          >
            Keep my edits
          </Button>
        </Alert>
      )}
      <form
        className="editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const result = await mutation(
              `/aliases/${encodeURIComponent(alias.id)}`,
              "PATCH",
              {
                baseVersion: draft.base.version,
                ...(draft.label !== draft.base.label
                  ? { label: draft.label }
                  : {}),
                ...(draft.note !== (draft.base.note ?? "")
                  ? { note: draft.note }
                  : {}),
              },
            );
            accept(result);
            const fresh = result.snapshot.aliases.find(
              (item) => item.id === alias.id,
            )!;
            setDraft({
              base: fresh,
              label: fresh.label,
              note: fresh.note ?? "",
            });
          });
        }}
      >
        <Stack gap="md">
          <TextInput
            label="Label"
            value={draft.label}
            maxLength={256}
            disabled={busy}
            onChange={(event) =>
              setDraft({ ...draft, label: event.currentTarget.value })
            }
          />
          <Textarea
            label="Notes"
            value={draft.note}
            rows={5}
            maxLength={10_000}
            disabled={busy || checking || !noteReadable}
            onChange={(event) =>
              setDraft({ ...draft, note: event.currentTarget.value })
            }
          />
          {!checking && !noteReadable && (
            <Text size="sm" c="dimmed">
              iCloud did not return this note. Reopen the address to try again.
            </Text>
          )}
        </Stack>
        <Group className="address-actions" justify="space-between">
          <Switch
            label="Receive email"
            checked={alias.active}
            disabled={blocked || checking || changingActivation}
            aria-busy={changingActivation}
            thumbIcon={changingActivation ? <Loader size={12} /> : undefined}
            onChange={(event) => {
              const enabled = event.currentTarget.checked;
              if (blocked || checking || changingActivation) return;
              setChangingActivation(true);
              void run(async () => {
                const result = await mutation(
                  `/aliases/${encodeURIComponent(alias.id)}/${enabled ? "reactivate" : "deactivate"}`,
                  "POST",
                  {},
                );
                accept(result);
                const fresh = result.snapshot.aliases.find(
                  (item) => item.id === alias.id,
                );
                if (fresh)
                  setDraft((current) =>
                    fresh.label === current.base.label &&
                    fresh.note === current.base.note
                      ? { ...current, base: fresh }
                      : current,
                  );
              }).finally(() => setChangingActivation(false));
            }}
          />
          <Button
            ref={deleteButton}
            size="sm"
            variant="subtle"
            color="red"
            leftSection={<IconTrash size={17} />}
            disabled={blocked || checking}
            onClick={openDelete}
          >
            Delete
          </Button>
        </Group>
        <div className="modal-footer">
          <Button
            fullWidth
            type="submit"
            loading={busy}
            disabled={
              blocked || checking || !dirty || !noteReadable || conflict
            }
          >
            Save changes
          </Button>
        </div>
      </form>
    </div>
  );
}
