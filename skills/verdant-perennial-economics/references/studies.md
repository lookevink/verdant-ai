# Study-specific reconstruction

These notes adapt the retrospective protocols developed in the neighboring
supabase-hackathon research project to publicly served Verdant inputs. Read the
selected dataset's protocol and table definitions for exact source attribution,
units and versioned assumptions. No local research files are runtime dependencies.

## Stewart: almond hull-split irrigation

Tables `stewart_water` and `stewart_yield` use Control/RDI treatment labels. Use
the separately reported applied-water difference, not inconsistent consumptive
water aggregates. Water and yield averaging periods differ; disclose that.

Convert saved applied-water inches to acre-feet/acre by dividing by 12. Multiply
by marginal water value, subtract monitoring, hypothetical lost yield × kernel
price, and quality discount × price × remaining yield. Report hypothetical
quality/yield penalties as assumptions, not observed effects. Source treatment
means do not establish equivalence or identical future yield.

## García: almond regulated deficit irrigation

Table `garcia` includes total farm profit and `economic_farm_area_ha`. Divide
profit by that area (the historical budget is for five hectares) before
comparison. Start with alternative minus control historical profit/ha. Reprice
only the change from original assumptions:

`historical_delta + (Y_alt-Y_control)*(new_crop_price-original_crop_price) + (W_control-W_alt)*(new_water_price-original_tariff)*financing_factor - monitoring - Y_alt*new_crop_price*quality_discount`

Read original tariff from `constants`. Do not add the entire water saving again
on top of a historical budget that already includes water costs.

## Bellvert: drought pruning and recovery

Table `bellvert` has treatment-year means, drought and recovery years, and action
costs. Preserve Control and all pruning arms. The nonrandomized row-level design
limits causal inference. For each observed year, compare kernel yields at the
stated year-specific crop price, add only explicitly hypothetical quality value,
and discount from the declared base year. Deduct action costs with their stated
timing. The archived calculation deducts recorded action costs without discount;
label any change to that convention as a new sensitivity.

A hypothetical year-three yield gain may be valued and discounted separately,
but is not a measured recovery. Calculate the recovery needed to break even
rather than crediting unknown survival, replacement or terminal orchard value.

## Shackel: severe almond pruning

Table `shackel` compares `Pruned or pruned+kaolin` with `Non-modified` over all
four reported years. Preserve the pooled-treatment label. Discount annual
kernel-yield differences from 2009 at the chosen rate, multiply by kernel price,
and subtract the specified intervention cost once. Do not fabricate separate
pruning-only effects from the pooled group or extend beyond the observed horizon.

## CSIRO: Cabernet irrigation

Table `csiro` identifies harvest year and treatment name; `YLFW` is yield in
kg/ha, and `recorded_irrigation_mm` is total applied irrigation. Resolve C/RDI/PD
from labels, not row order. Keep all three years. The original study dataset also
contains the dated events used to reconcile full recorded irrigation. The
SKILL.md gives the annual economic identity and unit conversion.

Brix and yield are measured endpoints; an assumed quality-price multiplier must
remain separate. No year-by-year switching counterfactual can be inferred from
persistent irrigation programs.

## Abad: summer grape trimming

Table `summer` includes site/year, vines per hectare, and treatment/control yield
per vine. Convert each site-year separately before combining. Revenue change is
`price * density * (quality_multiplier * trimmed_yield - control_yield)`.
Without measured intervention cost, this is the break-even affordable cost, not
net profit. Without measured irrigation volume, it says nothing quantitative
about water savings. Retain all six site-years and show equal-site-year,
equal-site, and pooled-per-vine conventions when reproducing the study summary;
never pool unlike sites into a fictitious farm. Verify definitions before
reproducing any source-specific weighting. Composition units have limitations.

## Winter grape mechanization

Tables `winter`, `winter_cost`, `winter_metadata` hold five-year mean harvests,
operation costs by farm area, and vine density. Compare MAN to each mechanical
arm at the selected five-/30-hectare cost scale. Annual modeled change is:

`(crop_price - incremental_harvest_cost_per_kg) * (alternative_yield_per_vine - MAN_yield_per_vine) * vines_per_ha + MAN_pruning_cost - alternative_pruning_cost`

Separate pruning-operation savings from modeled net margin. The published
five-year means are not five annual observations. Exact yearly profits and
irrigation savings cannot be recovered from those means.
