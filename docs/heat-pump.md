# Heat pump model

`core/heatpump.js` turns "I might replace my gas furnace with a heat pump" into an hourly
electric load that the engine adds to the household, so the solar and battery sizing sees it.

## The model

For every hour of the meter record:

1. Find the outdoor temperature. The weather year with the same calendar year is used when
   we have it. Otherwise the hour gets the average of that day-of-year and hour over every
   weather year we hold (a climatology).
2. Heating need = `max(0, balance temperature - outdoor temperature)`, in degree-hours.
3. Electricity = need x k / COP.

`k` is a single constant chosen so that the most recent 365 days of the record sum to the
annual kWh you entered. If the record is shorter than a year, the sum is scaled pro rata
(its share of a year of the annual figure). The shape comes from the weather; the size
comes from you.

Defaults: 2,500 kWh/yr, COP 3.0, balance temperature 16 C (61 F). The rough starting guess
for a house is 3 kWh per square foot per year for southern California.

Note on COP: because `k` is fitted to the annual figure, COP cancels out of the totals. It
only matters when you want to read the heating the house gets (kWh x COP).

## How the engine treats it

The series is built outside the engine and stored in `kwhByHour`. The load is not in your
meter data (you do not own the heat pump yet), so it is added to the recorded load, not
taken out of it. It is never moved: heating happens when it is cold. While the weather is
still loading (`kwhByHour` is null) it adds nothing.

## Limits

- Heating only. No cooling mode yet (the code has a place for it).
- No defrost cycles, no backup resistance heat in hard freezes.
- No part-load COP curve: efficiency is one number all year, though real units are less
  efficient on cold nights.
- The balance temperature is the only knob for the shape. It lumps together insulation,
  thermostat setting and internal heat gains. Raise it for a leakier house.
- Hourly demand is a straight line in temperature. No thermal mass, no setback schedule, so
  the morning pickup peak is smoother than a real house.
- Weather is gridded reanalysis at about 5 km, not your thermostat.

## Reading it

On the Loads tab the card shows the annual kWh, COP and balance temperature. Raising the
balance temperature spreads heating over more hours and more of the year. Lowering it
concentrates the load in the coldest winter nights and mornings, which solar does not cover,
so a battery matters more. In a mild climate most of the heat pump's energy lands in
December to February, early morning and evening.
