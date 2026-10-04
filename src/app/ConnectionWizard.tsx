import { useState } from "react";
import {
  Accordion,
  Anchor,
  Button,
  Group,
  NativeSelect,
  Stack,
  Stepper,
  Text,
  Textarea,
  Title,
} from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import type { Connection, Region } from "../shared/types";
import { api } from "./api";

export function ConnectionWizard({
  connection,
  step,
  setStep,
  busy,
  run,
  connected,
}: {
  connection: Connection | null;
  step: string | null;
  setStep: (step: string) => void;
  busy: boolean;
  run: (task: () => Promise<void>) => Promise<void>;
  connected: () => Promise<void>;
}) {
  const [region, setRegion] = useState<Region>(connection?.region ?? "global");
  const [cookies, setCookies] = useState("");
  const importing = step === "import";
  const website =
    region === "china" ? "https://www.icloud.com.cn" : "https://www.icloud.com";
  return (
    <Stack gap="lg" className="wizard">
      <Stepper active={importing ? 1 : 0} allowNextStepsSelect={false}>
        <Stepper.Step label="Sign in" />
        <Stepper.Step label="Connect" />
      </Stepper>
      {!importing ? (
        <>
          <div>
            <Title order={3}>Sign in to iCloud</Title>
            <Text c="dimmed" mt="xs">
              Choose “Keep me signed in” if offered.
              {connection
                ? " Use the same Apple account."
                : " An iCloud+ account is required."}
            </Text>
          </div>
          {!connection && (
            <NativeSelect
              label="iCloud website"
              value={region}
              onChange={(event) =>
                setRegion(event.currentTarget.value as Region)
              }
              data={[
                { value: "global", label: "iCloud.com" },
                { value: "china", label: "iCloud.com.cn" },
              ]}
            />
          )}
          <Anchor
            href={website}
            target="_blank"
            rel="noreferrer"
            className="icloud-link"
          >
            Open iCloud <IconExternalLink size={17} />
          </Anchor>
          <div className="modal-footer">
            <Button fullWidth onClick={() => setStep("import")}>
              Continue
            </Button>
          </div>
        </>
      ) : (
        <form
          className="wizard-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              await api("/icloud/connection", "PUT", { cookies, region });
              setCookies("");
              await connected();
            });
          }}
        >
          <Text c="dimmed" mb="md">
            Copy your iCloud cookies using a desktop browser.
          </Text>
          <Accordion variant="default" mb="lg">
            <Accordion.Item value="instructions">
              <Accordion.Control>Where to find them</Accordion.Control>
              <Accordion.Panel>
                <ol className="cookie-instructions">
                  <li>
                    Sign in at{" "}
                    {region === "china" ? "iCloud.com.cn" : "iCloud.com"}.
                  </li>
                  <li>Open developer tools, select Network, then reload.</li>
                  <li>
                    Select an iCloud request and copy its Cookie request header.
                    A JSON cookie export also works.
                  </li>
                </ol>
              </Accordion.Panel>
            </Accordion.Item>
          </Accordion>
          <Textarea
            label="iCloud cookies"
            placeholder="Paste here"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            rows={6}
            maxLength={65_536}
            required
            disabled={busy}
            value={cookies}
            onChange={(event) => setCookies(event.currentTarget.value)}
          />
          <Text size="sm" c="dimmed" mt="xs">
            Keep these private. They are stored encrypted.
          </Text>
          <Group className="modal-footer" justify="space-between">
            <Button
              variant="default"
              disabled={busy}
              onClick={() => setStep("signin")}
            >
              Back
            </Button>
            <Button type="submit" loading={busy} disabled={!cookies.trim()}>
              Connect iCloud
            </Button>
          </Group>
        </form>
      )}
    </Stack>
  );
}
