import type { ChangePlanView } from '../../shared/panel'
import { shortSha } from '../lib/format'

function Items({
  title,
  items,
  numbered = false,
}: {
  title: string
  items: string[]
  numbered?: boolean
}) {
  if (items.length === 0) return null
  const List = numbered ? 'ol' : 'ul'
  return (
    <div className="mt-2">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      <List
        className={`mt-1 space-y-1 pl-5 text-foreground ${numbered ? 'list-decimal' : 'list-disc'}`}
      >
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </List>
    </div>
  )
}

/**
 * What the builder said it would change before it changed anything. The latest plan is the one the
 * reviewer measured the diff by; a run that continued the task kept it.
 */
export function PlanSection({ plans }: { plans: ChangePlanView[] }) {
  const plan = plans.at(-1)
  return (
    <section aria-label="Plan">
      <h2 className="mb-2 text-sm font-semibold">Plan</h2>
      {plan === undefined ? (
        <p className="text-sm text-muted-foreground">No plan was written for this task.</p>
      ) : (
        <div className="rounded border border-border bg-card p-3 text-sm">
          <p className="text-xs text-muted-foreground">
            by {plan.harness} on {shortSha(plan.baseSha)}
            {plans.length > 1 ? ` · the latest of ${plans.length}` : ''}
          </p>
          <h3 className="mt-2 text-xs font-semibold text-muted-foreground">Files</h3>
          {plan.files.length === 0 ? (
            <p className="mt-1 text-foreground">
              No file: the builder expected the code to already do what the issue asks.
            </p>
          ) : (
            <ul className="mt-1 space-y-1 pl-5 text-foreground list-disc">
              {plan.files.map((f) => (
                <li key={f.path}>
                  <code>{f.path}</code>
                  {f.why ? `: ${f.why}` : null}
                </li>
              ))}
            </ul>
          )}
          <Items title="Order" items={plan.order} numbered />
          <Items title="Risks" items={plan.risks} />
          <Items title="Proof" items={plan.proof} />
          <Items title="Out of scope" items={plan.outOfScope} />
        </div>
      )}
    </section>
  )
}
