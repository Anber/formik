import * as React from 'react';
import isEqual from 'react-fast-compare';
import warning from 'warning';
import deepmerge from 'deepmerge';
import { FormikProvider } from './connect';
import {
  FormikActions,
  FormikConfig,
  FormikErrors,
  FormikState,
  FormikTouched,
  FormikValues,
  FormikContext,
  FormikProps,
  PromiseOrValue,
} from './types';
import {
  isEmptyChildren,
  isFunction,
  isNaN,
  isPromise,
  isString,
  setIn,
  setNestedObjectValues,
  getActiveElement,
  getIn,
  getStateUpdater,
  ThrottledAction,
} from './utils';

type ValidationResult<TResult> = {
  key: object[];
  result: TResult;
} | null;

const emptyObject = Object.preventExtensions
  ? Object.preventExtensions({})
  : {};

export class Formik<Values = object, ExtraProps = {}> extends React.Component<
  FormikConfig<Values> & ExtraProps,
  FormikState<Values>
> {
  static defaultProps = {
    validateOnChange: true,
    validateOnBlur: true,
    isInitialValid: false,
    enableReinitialize: false,
  };

  initialValues: Values;
  didMount: boolean;
  hcCache: {
    [key: string]: (e: string | React.ChangeEvent<any>) => void;
  } = {};
  hbCache: {
    [key: string]: (e: any) => void;
  } = {};

  fields: {
    [field: string]: React.Component<any>;
  };

  private lastValidationResults: ValidationResult<
    PromiseOrValue<FormikErrors<Values>>
  > = null;
  private lastYupValidationResult: ValidationResult<
    PromiseLike<FormikErrors<Values>>
  > = null;
  private lastValidateHandlerResult: ValidationResult<
    PromiseLike<FormikErrors<Values>>
  > = null;

  private runValidationTask = new ThrottledAction<FormikErrors<Values>>(0);

  constructor(props: FormikConfig<Values> & ExtraProps) {
    super(props);
    this.state = {
      values: props.initialValues || (emptyObject as any),
      errors: emptyObject,
      touched: emptyObject,
      isSubmitting: false,
      isValidating: false,
      submitCount: 0,
    };
    this.didMount = false;
    this.fields = {};
    this.initialValues = props.initialValues || (emptyObject as any);
    warning(
      !(props.component && props.render),
      'You should not use <Formik component> and <Formik render> in the same <Formik> component; <Formik render> will be ignored'
    );

    warning(
      !(props.component && props.children && !isEmptyChildren(props.children)),
      'You should not use <Formik component> and <Formik children> in the same <Formik> component; <Formik children> will be ignored'
    );

    warning(
      !(props.render && props.children && !isEmptyChildren(props.children)),
      'You should not use <Formik render> and <Formik children> in the same <Formik> component; <Formik children> will be ignored'
    );
  }

  registerField = (name: string, Comp: React.Component<any>) => {
    this.fields[name] = Comp;
  };

  unregisterField = (name: string) => {
    delete this.fields[name];
  };

  componentDidMount() {
    this.didMount = true;
  }

  componentWillUnmount() {
    // This allows us to prevent setting state on an
    // unmounted component. This can occur if Formik is in a modal, and submission
    // toggles show/hide, and validation of a blur field takes longer than validation
    // before a submit.
    // @see https://github.com/jaredpalmer/formik/issues/597
    // @see https://reactjs.org/blog/2015/12/16/ismounted-antipattern.html
    this.didMount = false;
  }

  componentDidUpdate(prevProps: Readonly<FormikConfig<Values> & ExtraProps>) {
    // If the initialValues change, reset the form
    if (
      this.props.enableReinitialize &&
      !isEqual(prevProps.initialValues, this.props.initialValues)
    ) {
      this.initialValues = this.props.initialValues;
      // @todo refactor to use getDerivedStateFromProps?
      this.resetForm(this.props.initialValues);
    }
  }

  setErrors = (errors: FormikErrors<Values>) => {
    this.setState({ errors });
  };

  setTouched = (touched: FormikTouched<Values>) => {
    this.setState({ touched }, () => {
      if (this.props.validateOnBlur) {
        this.runValidations(this.state.values);
      }
    });
  };

  setValues = (values: FormikState<Values>['values']) => {
    this.setState({ values }, () => {
      if (this.props.validateOnChange) {
        this.runValidations(values);
      }
    });
  };

  setStatus = (status?: any) => {
    this.setState({ status });
  };

  setError = (error: any) => {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `Warning: Formik\'s setError(error) is deprecated and may be removed in future releases. Please use Formik\'s setStatus(status) instead. It works identically. For more info see https://github.com/jaredpalmer/formik#setstatus-status-any--void`
      );
    }
    this.setState({ error });
  };

  setSubmitting = (isSubmitting: boolean) => {
    if (this.didMount) {
      this.setState({ isSubmitting });
    }
  };

  /**
   * Run field level validation
   */
  validateField = (field: string) => {
    const callback = (error: string) => {
      if (this.didMount) {
        this.setState(getStateUpdater('isValidating', false));
        this.setState(getStateUpdater(`errors.${field}`, error));
      }
    };

    const result = this.runSingleFieldLevelValidation(
      field,
      getIn(this.state.values, field)
    );
    if (isPromise(result)) {
      this.setState(getStateUpdater('isValidating', true));
      result.then(callback, callback);
    } else {
      callback(result);
    }
  };

  runSingleFieldLevelValidation = (
    field: string,
    value: void | string
  ): PromiseOrValue<string> => {
    try {
      const result = this.fields[field].props.validate(value);
      return isPromise(result) ? result.then(x => x, e => e) : result;
    } catch (e) {
      return e;
    }
  };

  runFieldLevelValidations(
    values: FormikValues
  ): PromiseOrValue<FormikErrors<Values>> {
    const fieldKeysWithValidation: string[] = Object.keys(this.fields).filter(
      f =>
        this.fields &&
        this.fields[f] &&
        this.fields[f].props.validate &&
        isFunction(this.fields[f].props.validate)
    );

    // Construct an array with all of the field validation functions
    const fieldValidations: PromiseOrValue<
      string
    >[] = fieldKeysWithValidation.map(f =>
      this.runSingleFieldLevelValidation(f, getIn(values, f))
    );

    const callback = (fieldErrorsList: string[]) =>
      fieldErrorsList.reduce(
        (prev, curr, index) =>
          !!curr ? setIn(prev, fieldKeysWithValidation[index], curr) : prev,
        emptyObject as FormikErrors<Values>
      );

    if (fieldValidations.some(isPromise)) {
      return Promise.all(fieldValidations).then(callback);
    }

    return callback(fieldValidations as string[]);
  }

  runValidateHandler(
    values: FormikValues
  ): PromiseOrValue<FormikErrors<Values>> {
    const maybePromisedErrors = (this.props.validate as any)(values);
    if (maybePromisedErrors === undefined) {
      return emptyObject;
    }

    if (isPromise(maybePromisedErrors)) {
      if (
        !this.lastValidateHandlerResult ||
        this.lastValidateHandlerResult!.key[0] !== maybePromisedErrors
      ) {
        this.lastValidateHandlerResult = {
          key: [maybePromisedErrors],
          result: maybePromisedErrors.then(() => emptyObject, errors => errors),
        };
      }

      return this.lastValidateHandlerResult.result;
    }

    return maybePromisedErrors;
  }

  /**
   * Run validation against a Yup schema and optionally run a function if successful
   */
  runValidationSchema = (
    values: FormikValues
  ): PromiseLike<FormikErrors<Values>> => {
    const { validationSchema } = this.props;
    const schema = isFunction(validationSchema)
      ? validationSchema()
      : validationSchema;
    const cacheKey = [schema, values];
    if (
      this.lastYupValidationResult &&
      cacheKey.every((el, i) => el === this.lastYupValidationResult!.key[i])
    ) {
      return this.lastYupValidationResult.result;
    }

    this.lastYupValidationResult = {
      key: cacheKey,
      result: validateYupSchema(values, schema).then(
        () => emptyObject,
        (err: any) => yupToFormErrors(err)
      ) as PromiseLike<FormikErrors<Values>>,
    };

    return this.lastYupValidationResult.result;
  };

  /**
   * Run all validations methods and update state accordingly
   */
  runValidations = (
    values: FormikValues = this.state.values
  ): Promise<FormikErrors<Values>> => {
    return this.runValidationTask.enqueue(() => {
      const validationResults = [
        this.runFieldLevelValidations(values),
        this.props.validationSchema
          ? this.runValidationSchema(values)
          : emptyObject,
        this.props.validate ? this.runValidateHandler(values) : emptyObject,
      ];

      if (
        this.lastValidationResults &&
        validationResults.every(
          (el, i) => el === this.lastValidationResults!.key[i]
        )
      ) {
        const combinedErrors = this.lastValidationResults.result;
        if (this.didMount) {
          this.setState(getStateUpdater('isValidating', false));
          this.setState(getStateUpdater('errors', combinedErrors));
        }

        return Promise.resolve(combinedErrors);
      }

      this.setState({ isValidating: true });
      return Promise.all(validationResults).then(errors => {
        const combinedErrors = deepmerge.all<FormikErrors<Values>>(errors, {
          arrayMerge,
        });

        if (this.didMount) {
          this.setState(getStateUpdater('isValidating', false));
          this.setState(getStateUpdater('errors', combinedErrors));
        }

        this.lastValidationResults = {
          key: validationResults,
          result: combinedErrors,
        };
        return combinedErrors;
      });
    });
  };

  handleChange = (
    eventOrPath: string | React.ChangeEvent<any>
  ): void | ((eventOrTextValue: string | React.ChangeEvent<any>) => void) => {
    // @todo someone make this less disgusting.
    //
    // executeChange is the core of handleChange, we'll use it cache change
    // handlers like Preact's linkState.
    const executeChange = (
      eventOrTextValue: string | React.ChangeEvent<any>,
      maybePath?: string
    ) => {
      // By default, assume that the first argument is a string. This allows us to use
      // handleChange with React Native and React Native Web's onChangeText prop which
      // provides just the value of the input.
      let field = maybePath;
      let val = eventOrTextValue;
      let parsed;
      // If the first argument is not a string though, it has to be a synthetic React Event (or a fake one),
      // so we handle like we would a normal HTML change event.
      if (!isString(eventOrTextValue)) {
        // If we can, persist the event
        // @see https://reactjs.org/docs/events.html#event-pooling
        if ((eventOrTextValue as React.ChangeEvent<any>).persist) {
          (eventOrTextValue as React.ChangeEvent<any>).persist();
        }
        const {
          type,
          name,
          id,
          value,
          checked,
          outerHTML,
        } = (eventOrTextValue as React.ChangeEvent<any>).target;
        field = maybePath ? maybePath : name ? name : id;
        if (!field && process.env.NODE_ENV !== 'production') {
          warnAboutMissingIdentifier({
            htmlContent: outerHTML,
            documentationAnchorLink: 'handlechange-e-reactchangeeventany--void',
            handlerName: 'handleChange',
          });
        }
        val = /number|range/.test(type)
          ? ((parsed = parseFloat(value)), isNaN(parsed) ? '' : parsed)
          : /checkbox/.test(type) ? checked : value;
      }

      if (field) {
        // Set form fields by name
        this.setFieldValue(field!, val);
      }
    };

    // Actually execute logic above....
    // cache these handlers by key like Preact's linkState does for perf boost
    if (isString(eventOrPath)) {
      return isFunction(this.hcCache[eventOrPath])
        ? this.hcCache[eventOrPath] // return the cached handled
        : (this.hcCache[eventOrPath] = (
            // make a new one
            event: React.ChangeEvent<any> | string
          ) =>
            executeChange(
              event /* string or event, does not matter */,
              eventOrPath /* this is path to the field now */
            ));
    } else {
      executeChange(eventOrPath);
    }
  };

  setFieldValue = (
    field: string,
    value: any,
    shouldValidate: boolean = true
  ) => {
    if (this.didMount) {
      // Set form field by name
      this.setState(getStateUpdater(`values.${field}`, value), () => {
        if (this.props.validateOnChange && shouldValidate) {
          this.runValidations(this.state.values);
        }
      });
    }
  };

  handleSubmit = (e: React.FormEvent<HTMLFormElement> | undefined) => {
    if (e && e.preventDefault) {
      e.preventDefault();
    }

    // Warn if form submission is triggered by a <button> without a
    // specified `type` attribute during development. This mitigates
    // a common gotcha in forms with both reset and submit buttons,
    // where the dev forgets to add type="button" to the reset button.
    if (
      process.env.NODE_ENV !== 'production' &&
      typeof document !== 'undefined'
    ) {
      // Safely get the active element (works with IE)
      const activeElement = getActiveElement();
      if (
        activeElement !== null &&
        activeElement instanceof HTMLButtonElement
      ) {
        warning(
          !!(
            activeElement.attributes &&
            activeElement.attributes.getNamedItem('type')
          ),
          'You submitted a Formik form using a button with an unspecified `type` attribute.  Most browsers default button elements to `type="submit"`. If this is not a submit button, please add `type="button"`.'
        );
      }
    }

    this.submitForm();
  };

  submitForm = () => {
    // Recursively set all values to `true`.
    this.setState(prevState => ({
      touched: setNestedObjectValues<FormikTouched<Values>>(
        prevState.values,
        true
      ),
      isSubmitting: true,
      submitCount: prevState.submitCount + 1,
    }));

    return this.runValidations().then(combinedErrors => {
      const isValid = Object.keys(combinedErrors).length === 0;
      if (isValid) {
        this.executeSubmit();
      } else if (this.didMount) {
        // ^^^ Make sure Formik is still mounted before calling setState
        this.setState({ isSubmitting: false });
      }
    });
  };

  executeSubmit = () => {
    this.props.onSubmit(this.state.values, this.getFormikActions());
  };

  handleBlur = (eventOrString: any): void | ((e: any) => void) => {
    const executeBlur = (e: any, path?: string) => {
      if (e.persist) {
        e.persist();
      }
      const { name, id, outerHTML } = e.target;
      const field = path ? path : name ? name : id;

      if (!field && process.env.NODE_ENV !== 'production') {
        warnAboutMissingIdentifier({
          htmlContent: outerHTML,
          documentationAnchorLink: 'handleblur-e-any--void',
          handlerName: 'handleBlur',
        });
      }

      this.setFieldTouched(field, true);
    };

    if (isString(eventOrString)) {
      // cache these handlers by key like Preact's linkState does for perf boost
      return isFunction(this.hbCache[eventOrString])
        ? this.hbCache[eventOrString]
        : (this.hbCache[eventOrString] = (event: any) =>
            executeBlur(event, eventOrString));
    } else {
      executeBlur(eventOrString);
    }
  };

  setFieldTouched = (
    field: string,
    touched: boolean = true,
    shouldValidate: boolean = true
  ) => {
    // Set touched field by name
    this.setState(getStateUpdater(`touched.${field}`, touched), () => {
      if (this.props.validateOnBlur && shouldValidate) {
        this.runValidations(this.state.values);
      }
    });
  };

  setFieldError = (field: string, message: string | undefined) => {
    // Set form field by name
    this.setState(getStateUpdater(`errors.${field}`, message));
  };

  resetForm = (nextValues?: Values) => {
    const values = nextValues ? nextValues : this.props.initialValues;

    this.initialValues = values;

    this.setState({
      isSubmitting: false,
      isValidating: false,
      errors: emptyObject,
      touched: emptyObject,
      error: undefined,
      status: undefined,
      values,
      submitCount: 0,
    });
  };

  handleReset = () => {
    if (this.props.onReset) {
      const maybePromisedOnReset = (this.props.onReset as any)(
        this.state.values,
        this.getFormikActions()
      );

      if (isPromise(maybePromisedOnReset)) {
        (maybePromisedOnReset as Promise<any>).then(this.resetForm);
      } else {
        this.resetForm();
      }
    } else {
      this.resetForm();
    }
  };

  setFormikState = (s: any, callback?: (() => void)) =>
    this.setState(s, callback);

  getFormikActions = (): FormikActions<Values> => {
    return {
      resetForm: this.resetForm,
      submitForm: this.submitForm,
      validateForm: this.runValidations,
      validateField: this.validateField,
      setError: this.setError,
      setErrors: this.setErrors,
      setFieldError: this.setFieldError,
      setFieldTouched: this.setFieldTouched,
      setFieldValue: this.setFieldValue,
      setStatus: this.setStatus,
      setSubmitting: this.setSubmitting,
      setTouched: this.setTouched,
      setValues: this.setValues,
      setFormikState: this.setFormikState,
    };
  };

  getFormikComputedProps = () => {
    const { isInitialValid } = this.props;
    const dirty = !isEqual(this.initialValues, this.state.values);
    return {
      dirty,
      isValid: dirty
        ? this.state.errors && Object.keys(this.state.errors).length === 0
        : isInitialValid !== false && isFunction(isInitialValid)
          ? (isInitialValid as (props: this['props']) => boolean)(this.props)
          : (isInitialValid as boolean),
      initialValues: this.initialValues,
    };
  };

  getFormikBag = () => {
    return {
      ...this.state,
      ...this.getFormikActions(),
      ...this.getFormikComputedProps(),
      // Field needs to communicate with Formik during resets
      registerField: this.registerField,
      unregisterField: this.unregisterField,
      handleBlur: this.handleBlur,
      handleChange: this.handleChange,
      handleReset: this.handleReset,
      handleSubmit: this.handleSubmit,
      validateOnChange: this.props.validateOnChange,
      validateOnBlur: this.props.validateOnBlur,
    };
  };

  getFormikContext = (): FormikContext<any> => {
    return {
      ...this.getFormikBag(),
      validationSchema: this.props.validationSchema,
      validate: this.props.validate,
      initialValues: this.initialValues,
    };
  };

  render() {
    const { component, render, children } = this.props;
    const props = this.getFormikBag();
    const ctx = this.getFormikContext();
    return (
      <FormikProvider value={ctx}>
        {component
          ? React.createElement(component as any, props)
          : render
            ? render(props)
            : children // children come last, always called
              ? isFunction(children)
                ? (children as ((
                    props: FormikProps<Values>
                  ) => React.ReactNode))(props as FormikProps<Values>)
                : !isEmptyChildren(children)
                  ? React.Children.only(children)
                  : null
              : null}
      </FormikProvider>
    );
  }
}

function warnAboutMissingIdentifier({
  htmlContent,
  documentationAnchorLink,
  handlerName,
}: {
  htmlContent: string;
  documentationAnchorLink: string;
  handlerName: string;
}) {
  console.error(
    `Warning: Formik called \`${handlerName}\`, but you forgot to pass an \`id\` or \`name\` attribute to your input:

    ${htmlContent}

    Formik cannot determine which value to update. For more info see https://github.com/jaredpalmer/formik#${documentationAnchorLink}
  `
  );
}

/**
 * Transform Yup ValidationError to a more usable object
 */
export function yupToFormErrors<Values>(yupError: any): FormikErrors<Values> {
  let errors: any = emptyObject as FormikErrors<Values>;
  if (yupError.inner.length === 0) {
    return setIn(errors, yupError.path, yupError.message);
  }
  for (let err of yupError.inner) {
    if (!errors[err.path]) {
      errors = setIn(errors, err.path, err.message);
    }
  }
  return errors;
}

/**
 * Validate a yup schema.
 */
export function validateYupSchema<T extends FormikValues>(
  values: T,
  schema: any,
  sync: boolean = false,
  context: any = emptyObject
): Promise<Partial<T>> {
  let validateData: Partial<T> = {};
  for (let k in values) {
    if (values.hasOwnProperty(k)) {
      const key = String(k);
      validateData[key] = values[key] !== '' ? values[key] : undefined;
    }
  }
  return schema[sync ? 'validateSync' : 'validate'](validateData, {
    abortEarly: false,
    context: context,
  });
}

/**
 * deepmerge array merging algorithm
 * https://github.com/KyleAMathews/deepmerge#combine-array
 */
function arrayMerge(target: any[], source: any[], options: any): any[] {
  const destination = target.slice();

  source.forEach(function(e: any, i: number) {
    if (typeof destination[i] === 'undefined') {
      const cloneRequested = options.clone !== false;
      const shouldClone = cloneRequested && options.isMergeableObject(e);
      destination[i] = shouldClone
        ? deepmerge(Array.isArray(e) ? [] : emptyObject, e, options)
        : e;
    } else if (options.isMergeableObject(e)) {
      destination[i] = deepmerge(target[i], e, options);
    } else if (target.indexOf(e) === -1) {
      destination.push(e);
    }
  });
  return destination;
}
