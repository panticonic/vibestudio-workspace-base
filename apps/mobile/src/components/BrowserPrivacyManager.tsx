import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAtomValue } from "jotai";
import {
  BROWSER_PRIVACY_FORM_FILL_TYPES,
} from "@vibestudio/service-schemas/browserPrivacy";
import type { MobileBrowserPrivacySection, ShellClient } from "../services/shellClient";
import { themeColorsAtom } from "../state/themeAtoms";
import type { ThemeColors } from "../state/themeAtoms";
import { Button } from "./ui/primitives";

const PAGE_SIZE = 25;
const SECTIONS: readonly { id: MobileBrowserPrivacySection; label: string }[] = [
  { id: "credentials", label: "Passwords" },
  { id: "formFill", label: "Form fill" },
  { id: "inspect", label: "Site data" },
  { id: "debug", label: "Session" },
];

type Client = ShellClient["browserPrivacy"];
type PasswordPage = Awaited<ReturnType<Client["listPasswordSummariesPage"]>>;
type PasswordSummary = PasswordPage["items"][number];
type FormFillPage = Awaited<ReturnType<Client["listFormFillValuesPage"]>>;
type FormFillValue = FormFillPage["items"][number];

export interface BrowserPrivacyManagerProps {
  initialSection: MobileBrowserPrivacySection;
  client: Client;
  onClose(): void;
}

export function BrowserPrivacyManager({
  initialSection,
  client,
  onClose,
}: BrowserPrivacyManagerProps) {
  const colors = useAtomValue(themeColorsAtom);
  const [section, setSection] = useState<MobileBrowserPrivacySection>(initialSection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [passwords, setPasswords] = useState<PasswordSummary[]>([]);
  const [passwordTotal, setPasswordTotal] = useState(0);
  const [neverSave, setNeverSave] = useState<string[]>([]);
  const [neverSaveTotal, setNeverSaveTotal] = useState(0);
  const [formFill, setFormFill] = useState<FormFillValue[]>([]);
  const [formFillTotal, setFormFillTotal] = useState(0);
  const [cookieOrigins, setCookieOrigins] = useState<string[]>([]);
  const [cookieOriginTotal, setCookieOriginTotal] = useState(0);
  const [cookieRevision, setCookieRevision] = useState(0);

  const [fieldName, setFieldName] = useState("");
  const [fieldType, setFieldType] = useState("");
  const [fieldValue, setFieldValue] = useState("");
  const [fieldLabel, setFieldLabel] = useState("");
  const [editingFormFillId, setEditingFormFillId] = useState<number | null>(null);

  const [inspectOrigin, setInspectOrigin] = useState("");
  const [inspectResult, setInspectResult] = useState<{
    origin: string;
    cookieCount: number;
    passwordCount: number;
  } | null>(null);

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  const run = useCallback(async (operation: () => Promise<void>, success?: string) => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await operation();
      if (success) setStatus(success);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, []);

  const loadPasswords = useCallback(async () => {
    const [passwordPage, neverSavePage] = await Promise.all([
      client.listPasswordSummariesPage(0, PAGE_SIZE),
      client.getNeverSaveOriginsPage(0, PAGE_SIZE),
    ]);
    setPasswords(passwordPage.items);
    setPasswordTotal(passwordPage.total);
    setNeverSave(neverSavePage.items);
    setNeverSaveTotal(neverSavePage.total);
  }, [client]);

  const loadFormFill = useCallback(async () => {
    const page = await client.listFormFillValuesPage(0, PAGE_SIZE);
    setFormFill(page.items);
    setFormFillTotal(page.total);
  }, [client]);

  const loadCookieOrigins = useCallback(async () => {
    const page = await client.listCookieOriginsPage(0, PAGE_SIZE);
    setCookieOrigins(page.items);
    setCookieOriginTotal(page.total);
    setCookieRevision(page.revision);
  }, [client]);

  const refreshSection = useCallback(async () => {
    if (section === "credentials") await loadPasswords();
    else if (section === "formFill") await loadFormFill();
    else if (section === "debug") await loadCookieOrigins();
  }, [loadCookieOrigins, loadFormFill, loadPasswords, section]);

  useEffect(() => {
    void run(refreshSection);
  }, [refreshSection, run]);

  const confirm = useCallback((title: string, message: string): Promise<boolean> =>
    new Promise((resolve) => {
      Alert.alert(title, message, [
        { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
        { text: "Continue", style: "destructive", onPress: () => resolve(true) },
      ], { cancelable: true, onDismiss: () => resolve(false) });
    }), []);

  const mutate = useCallback(async (
    title: string,
    message: string,
    operation: () => Promise<unknown>,
    success: string,
    refresh: () => Promise<void>,
  ) => {
    if (!(await confirm(title, message))) return;
    await run(async () => {
      await operation();
      await refresh();
    }, success);
  }, [confirm, run]);

  const loadMorePasswords = () => void run(async () => {
    const page = await client.listPasswordSummariesPage(passwords.length, PAGE_SIZE);
    setPasswords((current) => [...current, ...page.items]);
    setPasswordTotal(page.total);
  });
  const loadMoreNeverSave = () => void run(async () => {
    const page = await client.getNeverSaveOriginsPage(neverSave.length, PAGE_SIZE);
    setNeverSave((current) => [...current, ...page.items]);
    setNeverSaveTotal(page.total);
  });
  const loadMoreFormFill = () => void run(async () => {
    const page = await client.listFormFillValuesPage(formFill.length, PAGE_SIZE);
    setFormFill((current) => [...current, ...page.items]);
    setFormFillTotal(page.total);
  });
  const loadMoreCookieOrigins = () => void run(async () => {
    const page = await client.listCookieOriginsPage(cookieOrigins.length, PAGE_SIZE);
    setCookieOrigins((current) => [...current, ...page.items]);
    setCookieOriginTotal(page.total);
    setCookieRevision(page.revision);
  });

  const resetForm = useCallback(() => {
    setEditingFormFillId(null);
    setFieldName("");
    setFieldType("");
    setFieldValue("");
    setFieldLabel("");
  }, []);

  const saveFormFill = () => void run(async () => {
    const normalizedType = fieldType.trim();
    if (!fieldName.trim()) throw new Error("Enter the form field name.");
    if (!fieldValue.trim()) throw new Error("Enter the value to save.");
    if (normalizedType && !(BROWSER_PRIVACY_FORM_FILL_TYPES as readonly string[]).includes(normalizedType)) {
      throw new Error(`Unknown form-fill type "${normalizedType}".`);
    }
    if (editingFormFillId === null) {
      await client.addFormFillValue({
        fieldName: fieldName.trim(),
        ...(normalizedType ? {
          type: normalizedType as (typeof BROWSER_PRIVACY_FORM_FILL_TYPES)[number],
        } : {}),
        value: fieldValue,
        ...(fieldLabel.trim() ? { displayLabel: fieldLabel.trim() } : {}),
      });
    } else {
      await client.updateFormFillValue(editingFormFillId, {
        value: fieldValue,
        displayLabel: fieldLabel.trim(),
      });
    }
    resetForm();
    await loadFormFill();
  }, editingFormFillId === null ? "Form-fill value saved." : "Form-fill value updated.");

  const inspectSite = () => void run(async () => {
    const input = inspectOrigin.trim();
    if (!input) throw new Error("Enter a site URL or origin.");
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Site inspection supports HTTP and HTTPS origins only.");
    }
    const origin = url.origin;
    setInspectResult(null);
    const [cookies, passwordCount] = await Promise.all([
      client.getCookieSiteSummary(origin),
      client.getPasswordCountForSite(origin),
    ]);
    setInspectResult({
      origin: cookies.origin,
      cookieCount: cookies.cookieCount,
      passwordCount: passwordCount.passwordCount,
    });
  });

  const title = useMemo(
    () => SECTIONS.find((candidate) => candidate.id === section)?.label ?? "Privacy",
    [section],
  );

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
      statusBarTranslucent={false}
    >
      <View style={[styles.root, { backgroundColor: colors.background }]}>
        <View style={[styles.header, { borderBottomColor: colors.borderSubtle }]}>
          <View style={styles.headerCopy}>
            <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>Browser privacy</Text>
            <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{title}</Text>
          </View>
          <Button label="Close" variant="ghost" onPress={onClose} />
        </View>
        <ScrollView
          horizontal
          style={styles.tabs}
          contentContainerStyle={styles.tabsContent}
          showsHorizontalScrollIndicator={false}
        >
          {SECTIONS.map((entry) => (
            <Pressable
              key={entry.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: section === entry.id }}
              onPress={() => setSection(entry.id)}
              style={[
                styles.tab,
                { borderColor: section === entry.id ? colors.primary : colors.border },
                section === entry.id && { backgroundColor: colors.accentSoft },
              ]}
            >
              <Text style={{ color: section === entry.id ? colors.primary : colors.textSecondary }}>
                {entry.label}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {section === "credentials" ? (
            <CredentialsSection
              colors={colors}
              passwords={passwords}
              passwordTotal={passwordTotal}
              neverSave={neverSave}
              neverSaveTotal={neverSaveTotal}
              busy={busy}
              onLoadMorePasswords={loadMorePasswords}
              onLoadMoreNeverSave={loadMoreNeverSave}
              onDeletePassword={(password) => void mutate(
                "Delete saved password?",
                `Remove the saved password for ${password.origin_url}?`,
                () => client.deletePassword(password.id),
                "Saved password deleted.",
                loadPasswords,
              )}
              onRemoveNeverSave={(origin) => void mutate(
                "Allow password saving?",
                `Remove ${origin} from the never-save list?`,
                () => client.removeNeverSave(origin),
                "Never-save rule removed.",
                loadPasswords,
              )}
            />
          ) : null}
          {section === "formFill" ? (
            <FormFillSection
              colors={colors}
              values={formFill}
              total={formFillTotal}
              busy={busy}
              fieldName={fieldName}
              fieldType={fieldType}
              fieldValue={fieldValue}
              fieldLabel={fieldLabel}
              editingId={editingFormFillId}
              onFieldName={setFieldName}
              onFieldType={setFieldType}
              onFieldValue={setFieldValue}
              onFieldLabel={setFieldLabel}
              onSave={saveFormFill}
              onCancelEdit={resetForm}
              onEdit={(value) => {
                setEditingFormFillId(value.id);
                setFieldName(value.fieldName);
                setFieldType(value.type ?? "");
                setFieldValue(value.value);
                setFieldLabel(value.displayLabel ?? "");
              }}
              onDelete={(value) => void mutate(
                "Delete form-fill value?",
                `Remove ${value.displayLabel || value.fieldName}?`,
                () => client.deleteFormFillValue(value.id),
                "Form-fill value deleted.",
                loadFormFill,
              )}
              onClear={() => void mutate(
                "Clear all form-fill values?",
                "This removes every saved form-fill value and cannot be undone.",
                () => client.clearFormFillValues(),
                "All form-fill values cleared.",
                loadFormFill,
              )}
              onLoadMore={loadMoreFormFill}
            />
          ) : null}
          {section === "inspect" ? (
            <InspectSection
              colors={colors}
              origin={inspectOrigin}
              result={inspectResult}
              busy={busy}
              onOrigin={(value) => {
                setInspectOrigin(value);
                setInspectResult(null);
              }}
              onInspect={inspectSite}
              onClear={() => inspectResult && void mutate(
                "Clear site cookies?",
                `Remove all cookies stored for ${inspectResult.origin}?`,
                () => client.clearCookiesForOrigin(inspectResult.origin),
                "Site cookies cleared.",
                async () => {
                  const summary = await client.getCookieSiteSummary(inspectResult.origin);
                  setInspectResult((current) => current && ({ ...current, cookieCount: summary.cookieCount }));
                },
              )}
            />
          ) : null}
          {section === "debug" ? (
            <DebugSection
              colors={colors}
              origins={cookieOrigins}
              total={cookieOriginTotal}
              revision={cookieRevision}
              busy={busy}
              onLoadMore={loadMoreCookieOrigins}
              onEndSession={() => void mutate(
                "End browser session?",
                "This removes session cookies from the shared browser vault.",
                () => client.endBrowserSession(),
                "Browser session ended.",
                loadCookieOrigins,
              )}
              onClearAll={() => void mutate(
                "Clear all browser cookies?",
                "This removes every cookie in the shared browser vault and cannot be undone.",
                () => client.clearAllCookies(),
                "All browser cookies cleared.",
                loadCookieOrigins,
              )}
            />
          ) : null}
          {busy ? <ActivityIndicator accessibilityLabel="Loading privacy data" color={colors.primary} /> : null}
          {error ? <Text accessibilityRole="alert" style={[styles.message, { color: colors.danger }]}>{error}</Text> : null}
          {status ? <Text accessibilityLiveRegion="polite" style={[styles.message, { color: colors.success }]}>{status}</Text> : null}
          <Text style={[styles.ownershipNote, { color: colors.textTertiary }]}>Protected values are available only to this trusted Vibestudio shell. Hosted panels and extensions receive no protected rows.</Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

function Card({ children, colors }: React.PropsWithChildren<{ colors: ThemeColors }>) {
  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>{children}</View>;
}

function CredentialsSection(props: {
  colors: ThemeColors;
  passwords: PasswordSummary[];
  passwordTotal: number;
  neverSave: string[];
  neverSaveTotal: number;
  busy: boolean;
  onLoadMorePasswords(): void;
  onLoadMoreNeverSave(): void;
  onDeletePassword(value: PasswordSummary): void;
  onRemoveNeverSave(origin: string): void;
}) {
  return <>
    <Card colors={props.colors}>
      <Text style={[styles.sectionTitle, { color: props.colors.text }]}>Saved passwords ({props.passwordTotal})</Text>
      {props.passwords.length === 0 ? <Empty colors={props.colors} text="No saved passwords." /> : props.passwords.map((password) => (
        <View key={password.id} style={[styles.row, { borderTopColor: props.colors.borderSubtle }]}>
          <View style={styles.rowCopy}>
            <Text style={[styles.rowTitle, { color: props.colors.text }]}>{password.origin_url}</Text>
            <Text style={[styles.body, { color: props.colors.textSecondary }]}>{password.username || "No username"}</Text>
          </View>
          <Button label="Delete" variant="danger" disabled={props.busy} onPress={() => props.onDeletePassword(password)} />
        </View>
      ))}
      {props.passwords.length < props.passwordTotal ? <Button label="Load more passwords" disabled={props.busy} onPress={props.onLoadMorePasswords} /> : null}
    </Card>
    <Card colors={props.colors}>
      <Text style={[styles.sectionTitle, { color: props.colors.text }]}>Never save ({props.neverSaveTotal})</Text>
      {props.neverSave.length === 0 ? <Empty colors={props.colors} text="No never-save rules." /> : props.neverSave.map((origin) => (
        <View key={origin} style={[styles.row, { borderTopColor: props.colors.borderSubtle }]}>
          <Text style={[styles.rowTitle, styles.rowCopy, { color: props.colors.text }]}>{origin}</Text>
          <Button label="Remove" disabled={props.busy} onPress={() => props.onRemoveNeverSave(origin)} />
        </View>
      ))}
      {props.neverSave.length < props.neverSaveTotal ? <Button label="Load more never-save rules" disabled={props.busy} onPress={props.onLoadMoreNeverSave} /> : null}
    </Card>
  </>;
}

function FormFillSection(props: {
  colors: ThemeColors;
  values: FormFillValue[];
  total: number;
  busy: boolean;
  fieldName: string;
  fieldType: string;
  fieldValue: string;
  fieldLabel: string;
  editingId: number | null;
  onFieldName(value: string): void;
  onFieldType(value: string): void;
  onFieldValue(value: string): void;
  onFieldLabel(value: string): void;
  onSave(): void;
  onCancelEdit(): void;
  onEdit(value: FormFillValue): void;
  onDelete(value: FormFillValue): void;
  onClear(): void;
  onLoadMore(): void;
}) {
  return <>
    <Card colors={props.colors}>
      <Text style={[styles.sectionTitle, { color: props.colors.text }]}>{props.editingId === null ? "Add form-fill value" : "Edit form-fill value"}</Text>
      <LabeledInput colors={props.colors} label="Field name" value={props.fieldName} onChangeText={props.onFieldName} editable={props.editingId === null} placeholder="email" />
      <LabeledInput colors={props.colors} label="Type (optional)" value={props.fieldType} onChangeText={props.onFieldType} editable={props.editingId === null} placeholder="email" />
      <LabeledInput colors={props.colors} label="Value" value={props.fieldValue} onChangeText={props.onFieldValue} placeholder="Saved value" />
      <LabeledInput colors={props.colors} label="Label (optional)" value={props.fieldLabel} onChangeText={props.onFieldLabel} placeholder="Work email" />
      <View style={styles.actions}>
        <Button label={props.editingId === null ? "Add value" : "Save changes"} variant="filled" disabled={props.busy} onPress={props.onSave} />
        {props.editingId !== null ? <Button label="Cancel edit" disabled={props.busy} onPress={props.onCancelEdit} /> : null}
      </View>
    </Card>
    <Card colors={props.colors}>
      <View style={styles.sectionHeadingRow}>
        <Text style={[styles.sectionTitle, { color: props.colors.text }]}>Saved form values ({props.total})</Text>
        <Button label="Clear all" variant="danger" disabled={props.busy || props.total === 0} onPress={props.onClear} />
      </View>
      {props.values.length === 0 ? <Empty colors={props.colors} text="No saved form-fill values." /> : props.values.map((value) => (
        <View key={value.id} style={[styles.valueRow, { borderTopColor: props.colors.borderSubtle }]}>
          <Text style={[styles.rowTitle, { color: props.colors.text }]}>{value.displayLabel || value.fieldName}</Text>
          <Text selectable style={[styles.protectedValue, { color: props.colors.text }]}>{value.value}</Text>
          <Text style={[styles.body, { color: props.colors.textSecondary }]}>{value.type ?? "untyped"}</Text>
          <View style={styles.actions}>
            <Button label="Edit" disabled={props.busy} onPress={() => props.onEdit(value)} />
            <Button label="Delete" variant="danger" disabled={props.busy} onPress={() => props.onDelete(value)} />
          </View>
        </View>
      ))}
      {props.values.length < props.total ? <Button label="Load more form-fill values" disabled={props.busy} onPress={props.onLoadMore} /> : null}
    </Card>
  </>;
}

function InspectSection(props: {
  colors: ThemeColors;
  origin: string;
  result: { origin: string; cookieCount: number; passwordCount: number } | null;
  busy: boolean;
  onOrigin(value: string): void;
  onInspect(): void;
  onClear(): void;
}) {
  return <Card colors={props.colors}>
    <Text style={[styles.sectionTitle, { color: props.colors.text }]}>Inspect one site</Text>
    <LabeledInput colors={props.colors} label="Site URL or origin" value={props.origin} onChangeText={props.onOrigin} placeholder="https://example.com" autoCapitalize="none" keyboardType="url" />
    <Button label="Inspect site data" variant="filled" disabled={props.busy} onPress={props.onInspect} />
    {props.result ? <View accessibilityLiveRegion="polite" style={[styles.inspectResult, { backgroundColor: props.colors.surfaceSunken }]}>
      <Text style={[styles.rowTitle, { color: props.colors.text }]}>{props.result.origin}</Text>
      <Text style={[styles.body, { color: props.colors.textSecondary }]}>{props.result.passwordCount} saved password{props.result.passwordCount === 1 ? "" : "s"}</Text>
      <Text style={[styles.body, { color: props.colors.textSecondary }]}>{props.result.cookieCount} cookie{props.result.cookieCount === 1 ? "" : "s"}</Text>
      <Button label="Clear site cookies" variant="danger" disabled={props.busy || props.result.cookieCount === 0} onPress={props.onClear} />
    </View> : null}
  </Card>;
}

function DebugSection(props: {
  colors: ThemeColors;
  origins: string[];
  total: number;
  revision: number;
  busy: boolean;
  onLoadMore(): void;
  onEndSession(): void;
  onClearAll(): void;
}) {
  return <>
    <Card colors={props.colors}>
      <Text style={[styles.sectionTitle, { color: props.colors.text }]}>Browser session</Text>
      <Text style={[styles.body, { color: props.colors.textSecondary }]}>The canonical vault currently has cookies for {props.total} origin{props.total === 1 ? "" : "s"} (revision {props.revision}). Mobile WebViews keep their own isolated site data; these controls manage the shared vault and desktop browser projection.</Text>
      <View style={styles.actions}>
        <Button label="End session" variant="danger" disabled={props.busy} onPress={props.onEndSession} />
        <Button label="Clear all cookies" variant="danger" disabled={props.busy || props.total === 0} onPress={props.onClearAll} />
      </View>
    </Card>
    <Card colors={props.colors}>
      <Text style={[styles.sectionTitle, { color: props.colors.text }]}>Cookie origins ({props.total})</Text>
      {props.origins.length === 0 ? <Empty colors={props.colors} text="No shared browser cookies." /> : props.origins.map((origin) => <Text key={origin} style={[styles.origin, { color: props.colors.text, borderTopColor: props.colors.borderSubtle }]}>{origin}</Text>)}
      {props.origins.length < props.total ? <Button label="Load more cookie origins" disabled={props.busy} onPress={props.onLoadMore} /> : null}
    </Card>
  </>;
}

function Empty({ colors, text }: { colors: ThemeColors; text: string }) {
  return <Text style={[styles.empty, { color: colors.textSecondary }]}>{text}</Text>;
}

function LabeledInput(props: React.ComponentProps<typeof TextInput> & { colors: ThemeColors; label: string }) {
  const { colors, label, ...inputProps } = props;
  return <View style={styles.inputGroup}>
    <Text style={[styles.inputLabel, { color: colors.textSecondary }]}>{label}</Text>
    <TextInput
      {...inputProps}
      accessibilityLabel={label}
      placeholderTextColor={colors.textTertiary}
      style={[styles.input, { color: colors.text, backgroundColor: colors.surfaceSunken, borderColor: colors.border }]}
    />
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { minHeight: 68, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  headerCopy: { flex: 1 },
  title: { fontSize: 21, fontWeight: "700" },
  subtitle: { fontSize: 13, marginTop: 2 },
  tabs: { flexGrow: 0 },
  tabsContent: { padding: 12, gap: 8 },
  tab: { minHeight: 42, minWidth: 82, paddingHorizontal: 14, borderWidth: 1, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  content: { padding: 16, gap: 14, paddingBottom: 48 },
  card: { padding: 16, borderWidth: 1, borderRadius: 14, gap: 12 },
  sectionTitle: { fontSize: 17, fontWeight: "700" },
  sectionHeadingRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 10 },
  body: { fontSize: 14, lineHeight: 20 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12 },
  valueRow: { gap: 5, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 12 },
  rowCopy: { flex: 1 },
  rowTitle: { fontSize: 15, fontWeight: "600" },
  protectedValue: { fontSize: 15 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  inputGroup: { gap: 5 },
  inputLabel: { fontSize: 13, fontWeight: "600" },
  input: { minHeight: 46, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, fontSize: 15 },
  inspectResult: { padding: 12, borderRadius: 10, gap: 5 },
  origin: { paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, fontSize: 14 },
  empty: { paddingVertical: 12, fontSize: 14 },
  message: { fontSize: 14, fontWeight: "600" },
  ownershipNote: { fontSize: 12, lineHeight: 17, marginTop: 8 },
});
