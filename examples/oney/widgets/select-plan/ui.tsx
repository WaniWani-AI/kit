import { useSendFollowUpMessage, useWidget, useWidgetState } from "@waniwani/kit/web";
import widget from "./widget.js";

const euros = (value: number) =>
	new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" }).format(value);

export default function SelectPlan() {
	// Typed off the widget's own `data` schema — no generated helpers, no
	// server type import.
	const { data } = useWidget(widget);
	const [state, setState] = useWidgetState<{ selectedPlanId: string | null }>({
		selectedPlanId: null,
	});
	const sendFollowUp = useSendFollowUpMessage();

	if (!data) {
		return <div className="oney-shell oney-shell--loading">Loading your plans…</div>;
	}

	const selected = state.selectedPlanId ?? data.selectedPlanId ?? null;

	const choose = async (planId: string, label: string) => {
		setState({ selectedPlanId: planId });
		await sendFollowUp(`I'll take the ${label} plan.`);
	};

	return (
		<div className="oney-shell">
			<header className="oney-header">
				<span className="oney-eyebrow">Split your payment</span>
				<h1 className="oney-total">{euros(data.amount)}</h1>
				{data.merchant ? <p className="oney-merchant">at {data.merchant}</p> : null}
			</header>

			<div
				className="oney-grid"
				data-llm={`${data.plans.length} instalment plans for ${euros(data.amount)}`}
			>
				{data.plans.map((plan) => (
					<button
						type="button"
						key={plan.id}
						className={`oney-card${selected === plan.id ? " oney-card--selected" : ""}`}
						onClick={() => choose(plan.id, plan.label)}
						data-llm={`${plan.label}: ${euros(plan.monthly)} per month, ${plan.fee === 0 ? "no fee" : `${euros(plan.fee)} fee`}`}
					>
						<span className="oney-card__label">{plan.label}</span>
						<span className="oney-card__monthly">
							{euros(plan.monthly)}
							<small>/month</small>
						</span>
						<span className="oney-card__tagline">{plan.tagline}</span>
						<span className="oney-card__fee">
							{plan.fee === 0 ? "No fee" : `${euros(plan.fee)} fee`} · {euros(plan.total)} total
						</span>
					</button>
				))}
			</div>

			<p className="oney-legal">
				Borrowing money costs money too. Check your repayment capacity before you commit.
			</p>
		</div>
	);
}
