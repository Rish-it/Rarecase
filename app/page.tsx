import { CaseRunner } from "@/components/case-runner";

export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Rarecase</h1>
        <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
          Turn elusive production bugs into reproducible tests, verified fixes, and human-approved
          pull requests.
        </p>
      </header>
      <CaseRunner />
    </main>
  );
}
