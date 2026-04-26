"use client";

import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

type Mode = "signin" | "signup";

export function LoginClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next") ?? "/";
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    const hash = window.location.hash;
    if (!hash) return;
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const code = params.get("error_code");
    const desc = params.get("error_description");
    if (code === "otp_expired" || desc) {
      setError("That sign-in link expired. Use email + password below instead.");
    }
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setInfo(null);
    const supabase = createClient();

    if (mode === "signup") {
      const { data: signUpData, error: err } = await supabase.auth.signUp({
        email: email.trim(),
        password,
      });
      if (err) {
        setBusy(false);
        setError(err.message);
        return;
      }
      // If email confirmation is OFF, Supabase returns a session immediately.
      if (signUpData.session) {
        router.push(nextPath);
        router.refresh();
        return;
      }
      // Email confirmation is ON — ask them to check inbox.
      setBusy(false);
      setInfo("Check your email for a confirmation link, then sign in here.");
      setMode("signin");
      return;
    }

    const { error: err } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    router.push(nextPath);
    router.refresh();
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold text-relay-text">
        {mode === "signin" ? "Sign in" : "Create account"}
      </h1>
      <p className="mt-2 text-sm text-relay-text/70">
        {mode === "signin"
          ? "Sign in to play Relay."
          : "Pick an email and password to get started."}
      </p>

      {error ? (
        <p className="mt-4 rounded-lg bg-relay-urgency/10 px-3 py-2 text-sm text-relay-urgency">
          {error}
        </p>
      ) : null}
      {info ? (
        <p className="mt-4 rounded-lg bg-relay-live/10 px-3 py-2 text-sm text-relay-text/80">
          {info}
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm font-medium text-relay-text">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg border border-relay-text/15 bg-relay-card px-3 py-2 text-relay-text outline-none ring-relay-live/40 focus:ring-2"
            placeholder="you@example.com"
            autoComplete="email"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium text-relay-text">
          Password
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-lg border border-relay-text/15 bg-relay-card px-3 py-2 text-relay-text outline-none ring-relay-live/40 focus:ring-2"
            placeholder="at least 6 characters"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />
        </label>

        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-relay-live px-4 py-2.5 font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {busy
            ? mode === "signin"
              ? "Signing in…"
              : "Creating account…"
            : mode === "signin"
              ? "Sign in"
              : "Create account"}
        </button>
      </form>

      <button
        type="button"
        onClick={() => {
          setMode(mode === "signin" ? "signup" : "signin");
          setError(null);
          setInfo(null);
        }}
        className="mt-5 text-center text-sm text-relay-text/60 underline"
      >
        {mode === "signin"
          ? "No account yet? Create one"
          : "Already have an account? Sign in"}
      </button>
    </main>
  );
}
