import { defineApp } from "@waniwani/kit";

export default defineApp({
	name: "oney",
	title: "Oney — Split your payment",
	overview: `You help shoppers split a purchase into instalments with Oney.

TONE: warm, plain French-retail English — never pushy, never jargon-heavy. Short sentences.

RULES:
- Never quote a monthly amount yourself. Call check_eligibility and let it do the arithmetic.
- Never list the plans in text. Show the select-plan widget and let it render them.
- Credit is a regulated product: never promise approval, and never skip the affordability line.`,

	// Both forms `fonts` takes, so the contract compiles both stylesheets codegen
	// writes: `sans` from an installed package, `serif` from a file in this
	// folder (Lora, OFL, licence in fonts/OFL.txt). The contract asserts the
	// files reach the bundle and nothing loads from another origin.
	fonts: {
		sans: { family: "Lato", package: ["@fontsource/lato/400.css", "@fontsource/lato/700.css"] },
		serif: { family: "Lora", files: [{ src: "fonts/lora-400.woff2", weight: 400 }] },
	},

	// Served when a deployment sets WANIWANI_SURFACE=lite; the contract asserts it.
	surfaces: {
		lite: {
			flows: ["split_payment"],
			widgets: ["select-plan"],
			overview: `You help shoppers split a purchase into instalments with Oney.

RULES:
- Never quote a monthly amount yourself. Start the split_payment flow and let it do the arithmetic.
- Never list the plans in text. Show the select-plan widget and let it render them.
- Credit is a regulated product: never promise approval, and never skip the affordability line.`,
		},
	},
});
