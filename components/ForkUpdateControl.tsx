"use client";

import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, RotateCcw } from "lucide-react";
import type { ForkUpdateInfo } from "@/bin/fork-update-state";
import { useI18n } from "@/lib/i18n";
import { isRecord } from "@/lib/type-guards";

const POLL_INTERVAL = 2_000;

function isForkUpdateInfo(value: unknown): value is ForkUpdateInfo {
  if (!isRecord(value) || typeof value.supported !== "boolean" || (value.reason !== undefined && typeof value.reason !== "string")) return false;
  const current = value.current;
  if (current !== null && (!isRecord(current) || typeof current.port !== "number" || !["service", "releaseDir", "commit", "version"].every((key) => typeof current[key] === "string"))) return false;
  const status = value.status;
  if (status === null) return true;
  return isRecord(status)
    && typeof status.attemptId === "string"
    && typeof status.startedAt === "string"
    && ["running", "succeeded", "failed", "up_to_date"].some((state) => state === status.state)
    && ["starting", "fetching", "merging", "installing", "typechecking", "testing", "building", "smoke", "publishing", "deploying", "complete"].some((stage) => stage === status.stage)
    && ["finishedAt", "fromVersion", "targetVersion", "commit", "upstreamCommit", "releaseDir", "error", "logFile"].every((key) => status[key] === undefined || typeof status[key] === "string");
}

export function ForkUpdateControl({ currentVersion }: { currentVersion: string | null }) {
  const { t } = useI18n();
  const [info, setInfo] = useState<ForkUpdateInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [checkingOutcome, setCheckingOutcome] = useState(false);
  const [connectionError, setConnectionError] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const submission = useRef<AbortController | null>(null);

  useEffect(() => () => submission.current?.abort(), []);

  useEffect(() => {
    if (submitting) return;
    const controller = new AbortController();
    let timer: number | undefined;
    async function poll() {
      try {
        const response = await fetch("/api/fork-update", { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error(String(response.status));
        const next: unknown = await response.json();
        if (!isForkUpdateInfo(next)) throw new Error();
        if (controller.signal.aborted) return;
        setInfo(next);
        setLoading(false);
        setCheckingOutcome(false);
        setConnectionError(false);
        if (next.status?.state === "running") timer = window.setTimeout(poll, POLL_INTERVAL);
      } catch {
        if (controller.signal.aborted) return;
        // A proxy handover can interrupt requests. Keep the last persisted phase
        // and the duplicate guard until the server can confirm the outcome.
        setConnectionError(true);
        timer = window.setTimeout(poll, POLL_INTERVAL);
      }
    }
    void poll();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [submitting, refresh]);

  const status = info?.status;
  const running = status?.state === "running";
  const disabled = loading || submitting || checkingOutcome || running || !info?.supported;

  async function update() {
    if (disabled || submission.current) return;
    const controller = new AbortController();
    submission.current = controller;
    setSubmitting(true);
    setRequestError(null);
    setConnectionError(false);
    try {
      const response = await fetch("/api/fork-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update" }),
        signal: controller.signal,
      });
      const next: unknown = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok && response.status !== 409) {
        setRequestError(isRecord(next) && typeof next.error === "string" ? next.error : t("forkUpdate.requestFailed", { status: response.status }));
        setCheckingOutcome(true);
        return;
      }
      if (!isForkUpdateInfo(next)) throw new Error();
      setInfo(next);
      setLoading(false);
      setCheckingOutcome(false);
    } catch {
      if (controller.signal.aborted) return;
      // The request may have started a worker even if its response was lost.
      // Reconcile with persisted status instead of issuing a second POST.
      setCheckingOutcome(true);
      setConnectionError(true);
    } finally {
      if (!controller.signal.aborted) {
        submission.current = null;
        setSubmitting(false);
        setRefresh((value) => value + 1);
      }
    }
  }

  return (
    <section aria-label={t("forkUpdate.title")} style={{ padding: 14, border: "1px solid var(--border)", borderRadius: "var(--radius-card)", background: "var(--bg-panel)", display: "flex", flexDirection: "column", gap: 10, minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{t("forkUpdate.title")}</div>
      <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 12, overflowWrap: "anywhere" }}>
        {t("forkUpdate.currentVersion", { version: info?.current?.version || currentVersion || t("settingsConfig.versionUnavailable") })}
      </div>
      <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>{t("forkUpdate.description")}</p>
      <div role="status" aria-live="polite" style={{ fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" }}>
        {submitting ? t("forkUpdate.submitting") : loading ? t("forkUpdate.loading") : checkingOutcome ? t("forkUpdate.checkingOutcome") : running ? t("forkUpdate.running", { phase: t(`forkUpdate.stage.${status.stage}`) }) : status?.state === "succeeded" ? t("forkUpdate.succeeded") : status?.state === "up_to_date" ? t("forkUpdate.upToDate") : status?.state === "failed" ? t("forkUpdate.failed") : t("forkUpdate.ready")}
      </div>
      {connectionError && <div role="status" style={{ color: "var(--text-muted)", fontSize: 12, lineHeight: 1.5 }}>{t("forkUpdate.reconnecting")}</div>}
      {(status?.state === "failed" || requestError || info?.supported === false) && (
        <div role="alert" style={{ color: "var(--status-error)", fontSize: 12, lineHeight: 1.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere", minWidth: 0 }}>
          {requestError || (info?.supported === false ? info.reason || t("forkUpdate.unsupported") : status?.error || t("forkUpdate.failureDetails"))}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => void update()} disabled={disabled} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--accent-strong)", borderRadius: "var(--radius-control)", background: "var(--accent-strong)", color: "var(--on-accent)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.6 : 1, fontSize: 12, fontWeight: 600 }}>
          {submitting || running ? <LoaderCircle size={13} aria-hidden="true" /> : <Download size={13} aria-hidden="true" />}
          {t("forkUpdate.action")}
        </button>
        {status?.state === "succeeded" && <button type="button" onClick={() => window.location.reload()} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 12px", border: "1px solid var(--border)", borderRadius: "var(--radius-control)", background: "transparent", color: "var(--text)", cursor: "pointer", fontSize: 12 }}><RotateCcw size={13} aria-hidden="true" />{t("forkUpdate.reload")}</button>}
      </div>
    </section>
  );
}
