// jest cannot load the ESM-only content-disposition@3; @fastify/static needs
// just these two in tests.
module.exports = {
  create: (filename, options) => `${(options && options.type) || 'attachment'}${filename ? `; filename="${filename}"` : ''}`,
  parse: (header) => ({ type: String(header).split(';')[0].trim(), parameters: {} }),
};
