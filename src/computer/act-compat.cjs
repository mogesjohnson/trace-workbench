'use strict';

// TRACE 2.0 returns a compact act result by default. Callers that read `result.observation`
// request the full 1.x form, but only after doctor advertises it: older servers reject unknown
// act fields under their strict schema.
function advertisesFullReturn(doctor) {
  return Array.isArray(doctor?.actResult?.returnObservation) && doctor.actResult.returnObservation.includes('full');
}

function createActCompat() {
  let full = false;
  const compat = {
    get full() { return full; },
    noteDoctor(result) { full = advertisesFullReturn(result); return result; },
    actArguments(args) { return full && args && args.returnObservation === undefined ? { ...args, returnObservation: 'full' } : args; },
    // Wraps a controller-shaped object (own doctor/act methods) without changing its other methods.
    wrapController(controller) {
      return { ...controller,
        doctor: async (...rest) => compat.noteDoctor(await controller.doctor(...rest)),
        act: (args, ...rest) => controller.act(compat.actArguments(args), ...rest) };
    },
    // Wraps call(name, args, ...rest); accepts both 'act' and 'trace_computer_act' names.
    wrap(call) {
      return async (name, args, ...rest) => {
        const tool = String(name).replace(/^trace_computer_/, '');
        const result = await call(name, tool === 'act' ? compat.actArguments(args) : args, ...rest);
        if (tool === 'doctor') compat.noteDoctor(result);
        return result;
      };
    },
  };
  return compat;
}

module.exports = { advertisesFullReturn, createActCompat };
