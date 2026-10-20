"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ShieldCheck } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { Suspense, useState, type FormEvent } from "react";

import { Logo } from "@/components/layout/sidebar";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { api, errorMessage, tokenStore } from "@/lib/api";

interface LoginResponse {
  status: "ok" | "mfa_required" | "mfa_setup";
  access_token?: string;
  mfa_token?: string;
  mfa_secret?: string;
  otpauth_url?: string;
}

function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const qc = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<LoginResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const finish = (token: string) => {
    tokenStore.set(token);
    qc.clear();
    const next = search.get("next");
    router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
  };

  const submitCredentials = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<LoginResponse>("/auth/login", { email, password });
      if (res.status === "ok" && res.access_token) finish(res.access_token);
      else setStep(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (!step?.mfa_token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<LoginResponse>("/auth/mfa/verify", { mfa_token: step.mfa_token, code });
      if (res.access_token) finish(res.access_token);
    } catch (err) {
      setError(errorMessage(err));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex justify-center">
          <Logo />
        </div>
        <div className="rounded-xl border border-line bg-surface p-6 shadow-card">
          {!step ? (
            <form onSubmit={submitCredentials} className="space-y-4">
              <div>
                <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
                <p className="mt-1 text-sm text-ink-2">Use your company account to continue.</p>
              </div>
              <Field label="Email" htmlFor="email">
                <Input id="email" type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} />
              </Field>
              <Field label="Password" htmlFor="password">
                <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              {error && <p className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">{error}</p>}
              <Button type="submit" variant="primary" className="w-full" loading={busy}>
                Continue
              </Button>
            </form>
          ) : (
            <form onSubmit={submitCode} className="space-y-4">
              <button type="button" onClick={() => { setStep(null); setCode(""); setError(null); }} className="flex items-center gap-1 text-xs text-ink-3 hover:text-ink">
                <ArrowLeft className="size-3.5" /> Back
              </button>
              <div className="flex items-start gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-subtle text-ink-2">
                  <ShieldCheck className="size-5" />
                </span>
                <div>
                  <h1 className="text-base font-semibold tracking-tight">
                    {step.status === "mfa_setup" ? "Set up two-factor authentication" : "Two-factor authentication"}
                  </h1>
                  <p className="mt-0.5 text-sm text-ink-2">
                    {step.status === "mfa_setup"
                      ? "Scan this code with your authenticator app, then enter the 6-digit code."
                      : "Enter the 6-digit code from your authenticator app."}
                  </p>
                </div>
              </div>
              {step.status === "mfa_setup" && step.otpauth_url && (
                <div className="flex flex-col items-center gap-3 rounded-lg border border-line bg-subtle/60 p-4">
                  <div className="rounded-md bg-white p-2">
                    <QRCodeSVG value={step.otpauth_url} size={148} />
                  </div>
                  <p className="text-center text-xs text-ink-3">
                    Can’t scan? Enter this key manually
                    <br />
                    <code className="mt-1 inline-block select-all font-mono text-xs tracking-wider text-ink">{step.mfa_secret}</code>
                  </p>
                </div>
              )}
              <Input
                autoFocus
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className="h-10 text-center font-mono text-lg tracking-[0.5em]"
              />
              {error && <p className="rounded-md bg-negative-soft px-3 py-2 text-sm text-negative">{error}</p>}
              <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={code.length !== 6}>
                Verify and sign in
              </Button>
            </form>
          )}
        </div>
        <p className="mt-6 text-center text-xs text-ink-3">Access is monitored and audited.</p>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
