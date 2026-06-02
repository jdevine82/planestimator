/* symbols.js — symbol library with AS/NZS 3000 Table C9 current defaults
 *
 * defaultCurrentA values are indicative starting points from AS/NZS 3000:2018
 * Table C9 (current contributions for demand calculations). Users can override
 * per-instance in the Properties panel.
 *
 * Exposes window.SYMBOL_LIB used by app.js.
 */
(function () {
  "use strict";

  // Default current contributions (A) per symbol type, based on AS/NZS 3000 Table C9.
  // These are stored on symbolTypes[type].defaultCurrentA and pre-fill the
  // "Load current" field in the Properties panel when a symbol is placed.
  //
  // Table C9 reference values (single phase, 230V):
  //   General lighting outlet (incl. downlight)  : 0.5 A  (≈115W allowance)
  //   Exhaust fan                                 : 0.5 A
  //   Ceiling fan                                 : 0.7 A
  //   Double power outlet (GPO) — each outlet     : 1.0 A  (Table C9: 10A socket = 1.0A)
  //   Single power outlet                         : 1.0 A
  //   Dedicated appliance outlet (dishwasher etc) : 2.0 A
  //   Air conditioning — small split (<2.5kW)     : 5.0 A
  //   Air conditioning — large split (≥2.5kW)     : 10.0 A
  //   Oven / cooktop                              : 10.0 A  (dedicated circuit)
  //   Electric hot water service                  : 10.0 A  (dedicated circuit)
  //   Safety / emergency lighting                 : 0.5 A
  //   Smoke detector (240V mains)                 : 0.1 A
  //   Data outlet / comms                         : 0.0 A  (passive, no load)
  //   TV aerial outlet                            : 0.0 A

  window.SYMBOL_LIB = {
    list: [],
    byId: {},
    symbolDataURL: function () { return ""; },
    categoryColors: {
      electrical: "#38bdf8",
      data:       "#34d399",
      hvac:       "#67e8f9",
      mechanical: "#fb923c",
      custom:     "#c084fc"
    },

    // Default current contributions per symbol type name (case-insensitive match
    // attempted by app.js when a new symbol type is first placed).
    // app.js reads symbolTypes[type].defaultCurrentA; this table provides the
    // seed values that voltageDrop.js and the Properties panel use.
    defaultCurrentByType: {
      // Lighting
      "light":              0.5,
      "lighting":           0.5,
      "downlight":          0.5,
      "oyster":             0.5,
      "batten":             0.5,
      "fluorescent":        0.5,
      "led":                0.5,
      "spotlight":          0.5,
      "wall_light":         0.5,
      "emergency_light":    0.5,
      "exit_light":         0.5,
      "safety_light":       0.5,

      // Fans
      "exhaust_fan":        0.5,
      "ceiling_fan":        0.7,
      "fan":                0.5,

      // Power outlets
      "gpo":                1.0,
      "double_gpo":         1.0,
      "single_gpo":         1.0,
      "power_outlet":       1.0,
      "weatherproof_gpo":   1.0,
      "usb_outlet":         1.0,

      // Dedicated appliances
      "dishwasher":         2.0,
      "washing_machine":    2.0,
      "dryer":              2.0,
      "microwave":          2.0,
      "fridge":             1.5,
      "freezer":            1.5,

      // HVAC
      "air_con":            5.0,
      "air_conditioning":   5.0,
      "split_system":       5.0,
      "ac_indoor":          5.0,
      "ac_outdoor":         5.0,
      "heat_pump":          5.0,

      // High-load dedicated circuits
      "oven":               10.0,
      "cooktop":            10.0,
      "range_hood":         2.0,
      "hot_water":          10.0,
      "water_heater":       10.0,
      "pool_pump":          5.0,

      // Detection / comms
      "smoke_detector":     0.1,
      "smoke_alarm":        0.1,
      "co_detector":        0.1,
      "doorbell":           0.1,
      "data":               0.0,
      "data_outlet":        0.0,
      "tv":                 0.0,
      "tv_outlet":          0.0,
      "phone":              0.0,
      "speaker":            0.0,
    }
  };
})();
