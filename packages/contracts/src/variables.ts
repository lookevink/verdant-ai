import { z } from "zod";
/** Supported variables and their only unit. Precipitation is the daily total. */
export const variableUnits = { air_temperature_max: "degC", air_temperature_min: "degC", precipitation_amount: "mm" } as const;
export type Variable = keyof typeof variableUnits;
export const variableSchema = z.enum(Object.keys(variableUnits) as [Variable, ...Variable[]]);
export const sourceIds = ["silo", "nclimgrid", "cpc"] as const;
export type SourceId = typeof sourceIds[number];
