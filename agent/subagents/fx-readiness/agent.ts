import { defineAgent } from "eve";

export default defineAgent({
  description:
    "Review Resplit Currency API FX package, source-custody, Worker smoke, and Vidux readiness without mutating release or infrastructure surfaces.",
  model: process.env.EVE_MODEL ?? "anthropic/claude-sonnet-4.6",
});
