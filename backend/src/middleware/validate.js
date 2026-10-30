const { validationResult } = require('express-validator');
const { error } = require('../utils/response');

/**
 * Answers the express-validator failures with [statusCode]. The routes that
 * existed first answer 422; the public /members endpoints answer 400, as
 * docs/members-contract.md specifies.
 */
const validateWithStatus = (statusCode) => (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return error(res, 'Validation failed', statusCode, errors.array());
  }
  next();
};

const validate = validateWithStatus(422);

module.exports = { validate, validateWithStatus };
