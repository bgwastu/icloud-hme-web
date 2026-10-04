import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  CopyButton,
  Group,
  Loader,
  Menu,
  Modal,
  Notification,
  SegmentedControl,
  Skeleton,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconDots,
  IconDownload,
  IconLogout,
  IconPlus,
  IconSearch,
} from "@tabler/icons-react";
import type { Snapshot } from "../shared/types";
import { api, ApiError, mutation, type MutationResult } from "./api";
import { AddressEditor, type AddressDraft } from "./AddressEditor";
import { ConnectionWizard } from "./ConnectionWizard";
import { locationHref, useAppLocation } from "./location";

const empty: Snapshot = { aliases: [], connection: null, operations: [] };
export function App() {
  const { search, params, navigate, close } = useAppLocation();
  const mobile = useMediaQuery("(max-width: 40em)");
  const [snapshot, setSnapshot] = useState<Snapshot>(empty);
  const current = useRef(snapshot);
  const [loading, setLoading] = useState(true),
    [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const mutationBusy = useRef(false),
    syncing = useRef(false);
  const [syncVisible, setSyncVisible] = useState(false),
    [syncError, setSyncError] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const nextSync = useRef(0),
    retryDelay = useRef(60_000);
  const drafts = useRef(new Map<string, AddressDraft>());
  const [newLabel, setNewLabel] = useState(""),
    [newNote, setNewNote] = useState("");
  const previousConnection = useRef<string | null>(null);
  const dialog = params.get("dialog"),
    addressId = params.get("address");
  const selected = snapshot.aliases.find((alias) => alias.id === addressId);
  const query = params.get("q") ?? "";
  const filter = ["active", "inactive"].includes(params.get("status") ?? "")
    ? params.get("status")!
    : "all";
  const wizard = dialog === "connect",
    opened = wizard || dialog === "new" || Boolean(addressId);
  const blocked =
    busy ||
    snapshot.operations.length > 0 ||
    snapshot.connection?.status !== "connected";
  const update = useCallback((data: Snapshot) => {
    current.current = data;
    setSnapshot(data);
  }, []);
  const load = useCallback(async () => {
    const data = await api<Snapshot>("/aliases");
    update(data);
    setLoaded(true);
    return data;
  }, [update]);
  const sync = useCallback(
    async (foreground = false) => {
      if (
        mutationBusy.current ||
        syncing.current ||
        current.current.connection?.status !== "connected" ||
        !navigator.onLine ||
        document.visibilityState === "hidden"
      )
        return;
      if (
        Date.now() < nextSync.current &&
        (!foreground || retryDelay.current > 60_000)
      )
        return;
      syncing.current = true;
      setSyncVisible(true);
      try {
        update(
          await api<Snapshot>("/aliases/sync", "POST", { automatic: true }),
        );
        setSyncError("");
        retryDelay.current = 60_000;
        nextSync.current = Date.now() + 300_000;
      } catch (caught) {
        const code =
          caught instanceof ApiError ? caught.details.code : "network_error";
        if (code === "reconnect_required") await load().catch(() => undefined);
        else if (code !== "busy")
          setSyncError(
            code === "authentication_required"
              ? "Your app login expired. Reload to sign in."
              : "Could not update from iCloud. Retrying automatically.",
          );
        if (code === "rate_limited")
          retryDelay.current = Math.max(retryDelay.current, 300_000);
        nextSync.current =
          Date.now() + (code === "busy" ? 15_000 : retryDelay.current);
        if (code !== "busy")
          retryDelay.current = Math.min(retryDelay.current * 2, 900_000);
      } finally {
        syncing.current = false;
        setSyncVisible(false);
      }
    },
    [load, update],
  );
  useEffect(() => {
    void load()
      .then(() => {
        setLoading(false);
        void sync();
      })
      .catch((caught: Error) => setSyncError(caught.message))
      .finally(() => setLoading(false));
    const timer = window.setInterval(() => void sync(), 30_000);
    const foreground = () => void sync(true);
    window.addEventListener("focus", foreground);
    window.addEventListener("online", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", foreground);
      window.removeEventListener("online", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [load, sync]);
  useEffect(() => {
    if (!loaded) return;
    const status = snapshot.connection?.status ?? "not_connected";
    if (
      status !== "connected" &&
      previousConnection.current !== status &&
      new URLSearchParams(window.location.search).get("dialog") !== "connect"
    )
      navigate({ dialog: "connect", step: "signin" }, true);
    previousConnection.current = status;
  }, [loaded, snapshot.connection?.status, navigate]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    setError("");
  }, [addressId, dialog]);
  const run = useCallback(
    async (task: () => Promise<void>) => {
      if (mutationBusy.current) return;
      mutationBusy.current = true;
      setBusy(true);
      setError("");
      try {
        await task();
      } catch (caught) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not complete the change.",
        );
        await load().catch(() => undefined);
      } finally {
        mutationBusy.current = false;
        setBusy(false);
      }
    },
    [load],
  );
  function accept(result: MutationResult) {
    update(result.snapshot);
    if (result.operation.status !== "succeeded")
      throw new ApiError({
        code: "needs_verification",
        message: "Check this change with iCloud before trying again.",
        requestId: "",
        operationId: result.operation.id,
      });
    setNotice("Saved");
  }
  function closeDialog() {
    if (busy) return;
    setError("");
    close();
  }
  const filtered = snapshot.aliases.filter(
    (alias) =>
      (filter === "all" || alias.active === (filter === "active")) &&
      `${alias.label} ${alias.email} ${alias.note ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const modalTitle = wizard
    ? snapshot.connection
      ? "Reconnect iCloud"
      : "Connect iCloud"
    : dialog === "new"
      ? "New address"
      : dialog === "delete"
        ? "Delete address"
        : "Edit address";
  return (
    <>
      <header className="app-header">
        <div className="header-inner">
          <a
            className="brand"
            href="/"
            onClick={(event) => {
              if (!event.metaKey && !event.ctrlKey) {
                event.preventDefault();
                if (!busy)
                  navigate({ address: null, dialog: null, step: null }, true);
              }
            }}
          >
            <img src="/logo.svg" width="34" height="34" alt="" />
            <span>iCloud Hide My Email</span>
          </a>
          <Menu position="bottom-end" width={180}>
            <Menu.Target>
              <ActionIcon
                variant="subtle"
                color="gray"
                aria-label="More options"
              >
                <IconDots size={22} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                component="a"
                href="/api/aliases/export"
                download
                leftSection={<IconDownload size={17} />}
              >
                Export addresses
              </Menu.Item>
              <Menu.Item
                component="a"
                href="/cdn-cgi/access/logout"
                leftSection={<IconLogout size={17} />}
              >
                Logout
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </div>
      </header>
      <main className="app-main">
        <div className="list-heading">
          <div className="heading-title">
            <Title order={1}>Addresses</Title>
            {syncVisible && (
              <Loader size={15} aria-label="Updating addresses" />
            )}
          </div>
          <Button
            leftSection={<IconPlus size={18} />}
            disabled={blocked || !loaded}
            onClick={() => {
              setNewLabel("");
              setNewNote("");
              navigate({ dialog: "new", address: null });
            }}
          >
            New address
          </Button>
        </div>
        {syncError && (
          <Alert color="yellow" mb="md" role="alert">
            {syncError}
            {!loaded && (
              <Button
                variant="subtle"
                size="sm"
                onClick={() => window.location.reload()}
              >
                Reload
              </Button>
            )}
          </Alert>
        )}
        {snapshot.connection?.status === "reconnect_required" && !wizard && (
          <Alert color="yellow" mb="md">
            <Group justify="space-between">
              <Text size="sm">Reconnect iCloud to make changes.</Text>
              <Button
                size="sm"
                variant="light"
                onClick={() => navigate({ dialog: "connect", step: "signin" })}
              >
                Reconnect
              </Button>
            </Group>
          </Alert>
        )}
        {snapshot.operations.map((operation) => (
          <Alert color="yellow" mb="md" key={operation.id}>
            <Group justify="space-between">
              <Text size="sm">A change needs checking.</Text>
              <Button
                size="sm"
                variant="light"
                disabled={busy || snapshot.connection?.status !== "connected"}
                onClick={() =>
                  void run(async () => {
                    const result = await api<MutationResult>(
                      `/operations/${encodeURIComponent(operation.id)}/reconcile`,
                      "POST",
                    );
                    update(result.snapshot);
                    setNotice(
                      result.operation.status === "succeeded"
                        ? "Change confirmed"
                        : "Change was not applied",
                    );
                  })
                }
              >
                Check iCloud
              </Button>
            </Group>
          </Alert>
        ))}
        <div className="list-tools">
          <TextInput
            aria-label="Search addresses"
            placeholder="Search addresses"
            leftSection={<IconSearch size={19} />}
            size="md"
            value={query}
            onChange={(event) =>
              navigate({ q: event.currentTarget.value || null }, true)
            }
          />
          <SegmentedControl
            aria-label="Filter addresses"
            size="sm"
            value={filter}
            onChange={(value) =>
              navigate({ status: value === "all" ? null : value }, true)
            }
            data={[
              { value: "all", label: "All" },
              { value: "active", label: "Active" },
              { value: "inactive", label: "Inactive" },
            ]}
          />
        </div>
        <section
          className="address-list"
          aria-label="Addresses"
          aria-busy={loading}
        >
          {loading ? (
            <Stack gap="lg" p="lg">
              {[1, 2, 3].map((key) => (
                <div key={key}>
                  <Skeleton height={17} width="40%" />
                  <Skeleton mt="xs" height={14} width="65%" />
                </div>
              ))}
            </Stack>
          ) : filtered.length ? (
            filtered.map((alias) => (
              <div className="address-row" key={alias.id}>
                <a
                  className="address-link"
                  href={locationHref(search, {
                    address: alias.id,
                    dialog: null,
                    step: null,
                  })}
                  aria-label={`Open ${alias.label || alias.email}`}
                  onClick={(event) => {
                    if (
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey
                    )
                      return;
                    event.preventDefault();
                    navigate({ address: alias.id, dialog: null, step: null });
                  }}
                >
                  <span className="row-label">
                    {alias.label || "Untitled address"}
                  </span>
                  <span className="row-email">{alias.email}</span>
                  {alias.note && <span className="row-note">{alias.note}</span>}
                </a>
                <Badge
                  className="row-status"
                  size="sm"
                  variant="light"
                  color={alias.active ? "green" : "gray"}
                  tt="none"
                >
                  {alias.active ? "Active" : "Inactive"}
                </Badge>
                <CopyButton value={alias.email}>
                  {({ copied, copy }) => (
                    <ActionIcon
                      variant="subtle"
                      color={copied ? "green" : "gray"}
                      onClick={copy}
                      aria-label={`Copy ${alias.email}`}
                    >
                      {copied ? (
                        <IconCheck size={19} />
                      ) : (
                        <IconCopy size={19} />
                      )}
                    </ActionIcon>
                  )}
                </CopyButton>
                <IconChevronRight
                  size={16}
                  className="row-chevron"
                  aria-hidden="true"
                />
              </div>
            ))
          ) : (
            <div className="empty-list">
              <Text c="dimmed">
                {query || filter !== "all"
                  ? "No matching addresses"
                  : "No addresses yet"}
              </Text>
              {query || filter !== "all" ? (
                <Button
                  variant="subtle"
                  mt="sm"
                  onClick={() => navigate({ q: null, status: null }, true)}
                >
                  Clear filters
                </Button>
              ) : (
                snapshot.connection?.status === "connected" && (
                  <Button
                    variant="subtle"
                    mt="sm"
                    onClick={() => navigate({ dialog: "new" })}
                  >
                    Create an address
                  </Button>
                )
              )}
            </div>
          )}
        </section>
        {!opened && error && (
          <Alert color="red" mt="md" role="alert">
            {error}
          </Alert>
        )}
      </main>
      <Modal
        opened={opened && !loading}
        onClose={closeDialog}
        title={modalTitle}
        size="md"
        centered
        fullScreen={mobile}
        closeOnClickOutside={!busy && (!wizard || Boolean(snapshot.connection))}
        closeOnEscape={!busy && (!wizard || Boolean(snapshot.connection))}
        withCloseButton={!wizard || Boolean(snapshot.connection)}
        closeButtonProps={{ "aria-label": "Close", disabled: busy }}
        transitionProps={{ transition: "fade", duration: 120 }}
        overlayProps={{ backgroundOpacity: 0.35 }}
        classNames={{
          content: "app-modal-content",
          body: "app-modal-body",
          header: "app-modal-header",
          title: "app-modal-title",
        }}
      >
        {error && (
          <Alert color="red" mb="md" role="alert">
            {error}
          </Alert>
        )}
        {wizard ? (
          <ConnectionWizard
            connection={snapshot.connection}
            step={params.get("step")}
            setStep={(step) => navigate({ step }, true)}
            busy={busy}
            run={run}
            connected={async () => {
              await load();
              setSyncError("");
              setError("");
              nextSync.current = Date.now() + 300_000;
              retryDelay.current = 60_000;
              navigate({ dialog: null, step: null }, true);
              setNotice("iCloud connected");
            }}
          />
        ) : dialog === "new" ? (
          <form
            className="editor"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const result = await mutation("/aliases", "POST", {
                  label: newLabel,
                  note: newNote,
                });
                accept(result);
                setNotice("Address created");
                close();
              });
            }}
          >
            <Stack gap="md">
              <TextInput
                label="Label"
                size="md"
                placeholder="Where you’ll use it"
                data-autofocus
                required
                maxLength={256}
                value={newLabel}
                disabled={busy}
                onChange={(event) => setNewLabel(event.currentTarget.value)}
              />
              <Textarea
                label="Notes (optional)"
                size="md"
                rows={4}
                maxLength={10_000}
                value={newNote}
                disabled={busy}
                onChange={(event) => setNewNote(event.currentTarget.value)}
              />
            </Stack>
            <div className="modal-footer">
              <Button
                type="submit"
                fullWidth
                loading={busy}
                disabled={blocked || !newLabel.trim()}
              >
                Create address
              </Button>
            </div>
          </form>
        ) : selected ? (
          <AddressEditor
            key={selected.id}
            alias={selected}
            deleting={dialog === "delete"}
            busy={busy}
            blocked={blocked}
            drafts={drafts.current}
            run={run}
            update={update}
            accept={accept}
            openDelete={() => navigate({ dialog: "delete" })}
            cancelDelete={closeDialog}
            deleted={() => {
              navigate({ address: null, dialog: null, step: null }, true);
              setNotice("Address deleted");
            }}
          />
        ) : addressId ? (
          <Text c="dimmed">Address not found.</Text>
        ) : null}
      </Modal>
      {notice && (
        <Notification
          className="app-notice"
          icon={<IconCheck size={17} />}
          color="blue"
          withCloseButton={false}
          role="status"
        >
          {notice}
        </Notification>
      )}
    </>
  );
}
