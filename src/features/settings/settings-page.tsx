import { useEffect, useState } from "react";
import { Plus, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { ProviderConfig } from "@/lib/types";
import { useSettingsStore } from "@/stores/settings";
import { ProviderCard } from "./provider-card";
import { ProviderForm } from "./provider-form";

const emptyForm = { name: "", baseUrl: "", model: "", key: "" };

export function SettingsPage() {
  const { t } = useTranslation();
  const { providers, activeProviderId, removeProvider, setActiveProvider, deleteKey, hasKey } =
    useSettingsStore();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [keyStates, setKeyStates] = useState<Record<string, boolean>>({});
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refreshKeyStates = () => {
    for (const p of providers) {
      void hasKey(p.id).then((has) =>
        setKeyStates((s) => (s[p.id] === has ? s : { ...s, [p.id]: has })),
      );
    }
  };

  const providerIds = providers.map((p) => p.id).join(",");

  useEffect(() => {
    refreshKeyStates();
  }, [providerIds]);

  const openNewForm = () => {
    setEditingId(null);
    setDeleteError(null);
    setFormKey((k) => k + 1);
    setFormOpen(true);
  };

  const openEditForm = (p: ProviderConfig) => {
    setEditingId(p.id);
    setDeleteError(null);
    setFormKey((k) => k + 1);
    setFormOpen(true);
  };

  const handleDeleteProvider = async (id: string) => {
    setDeleteError(null);
    try {
      await deleteKey(id);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
      return; // provider row stays; key was not removed
    }
    removeProvider(id);
  };

  const editingProvider = editingId ? providers.find((p) => p.id === editingId) : undefined;

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 p-6">
      <h1 className="text-xl font-semibold">{t("settings.title")}</h1>

      <div className="mt-4 flex items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
        <ShieldCheck className="size-4 shrink-0" />
        {t("settings.securityNote")}
      </div>

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-base font-semibold">{t("settings.providers")}</h2>
        <Button size="sm" onClick={openNewForm}>
          <Plus className="size-4" />
          {t("settings.addProvider")}
        </Button>
      </div>

      {providers.length === 0 && !formOpen && (
        <p className="mt-4 text-sm text-muted-foreground">{t("settings.noProviders")}</p>
      )}

      {deleteError && (
        <p className="mt-4 text-xs text-destructive">
          {t("settings.deleteKeyFailed", { error: deleteError })}
        </p>
      )}

      <div className="mt-3 flex flex-col gap-3">
        {providers.map((p) => (
          <ProviderCard
            key={p.id}
            provider={p}
            isActive={activeProviderId === p.id}
            hasKey={keyStates[p.id] ?? false}
            onSetActive={() => setActiveProvider(p.id)}
            onEdit={() => openEditForm(p)}
            onDelete={() => handleDeleteProvider(p.id)}
          />
        ))}
      </div>

      {formOpen && (
        <ProviderForm
          key={formKey}
          editingId={editingId}
          initial={editingProvider ?? emptyForm}
          onCancel={() => setFormOpen(false)}
          onSaved={() => {
            setFormOpen(false);
            setEditingId(null);
          }}
          onKeySaved={(id) => setKeyStates((s) => ({ ...s, [id]: true }))}
        />
      )}
    </div>
  );
}
