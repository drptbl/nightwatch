module.exports = new (function() {

  /**
   * Given selector argument, build the final selector
   *
   * @param {Object} elementObj The original element object
   * @param {Array} args The arguments will be applied to the selector
   * @returns {Object} The built element object
   */
  function convertSelector(elementObj, args){
    if(typeof elementObj.selector !== 'function'){
      throw new Error(elementObj.name + ' was called as a dynamic page object, but with no function type selector.');
    }
    var finalObj = Object.create(elementObj);
    finalObj.selector = finalObj.selector.apply(null, args);
    finalObj.parent = elementObj.parent;
    return finalObj;
  }

  /**
   * Given an element name, returns that element object
   *
   * @param {Object} parent The parent page or section
   * @param {string} elementName Name of element
   * @returns {Object} The element object
   */
  function getElement(parent, elementName) {
    elementName = elementName.substring(1);
    if(elementName in parent.elements){
      return parent.elements[elementName];
    }
    if (elementName.match(/[^<]+<.*>$/)) {
      var args = [];
      args = elementName.substring(elementName.indexOf('<') + 1, elementName.lastIndexOf('>')).split(',');
      elementName = elementName.substring(0, elementName.indexOf('<'));
      if(elementName in parent.elements){
        return convertSelector(parent.elements[elementName], args);
      }
    }
    throw new Error(elementName + ' was not found in "' + parent.name +
      '". Available elements: ' + Object.keys(parent.elements));
  }

  /**
   * Given a section name, returns that section object
   *
   * @param {Object} parent The parent page or section
   * @param {string} sectionName Name of section
   * @returns {Object} The section object
   */
  function getSection(parent, sectionName) {
    sectionName = sectionName.substring(1);
    if (!(sectionName in parent.section)) {
      throw new Error(sectionName + ' was not found in "' + parent.name +
        '". Available sections: ' + Object.keys(parent.sections));
    }
    return parent.section[sectionName];
  }

  /**
   * Calls use(Css|Xpath|Recursion) command
   *
   * Uses `useXpath`, `useCss`, and `useRecursion` commands.
   *
   * @param {Object} client The Nightwatch instance
   * @param {string} desiredStrategy (css selector|xpath|recursion)
   * @returns {null}
   */
  function setLocateStrategy(client, desiredStrategy) {
    var methodMap = {
      xpath : 'useXpath',
      'css selector' : 'useCss',
      recursion : 'useRecursion'
    };

    if (desiredStrategy in methodMap) {
      client.api[methodMap[desiredStrategy]]();
    }
  }

  /**
   * Creates a closure that enables calling commands and assertions on the page or section.
   * For all element commands and assertions, it fetches element's selector and locate strategy
   *  For elements nested under sections, it sets 'recursion' as the locate strategy and passes as its first argument to the command an array of its ancestors + self
   *  If the command or assertion is not on an element, it calls it with the untouched passed arguments
   *
   * @param {Object} parent The parent page or section
   * @param {function} commandFn The actual command function
   * @param {string} commandName The name of the command ("click", "containsText", etc)
   * @param {Boolean} [isChaiAssertion]
   * @returns {function}
   */
  function makeWrappedCommand(parent, commandFn, commandName, isChaiAssertion) {
    return function() {
      var args = Array.prototype.slice.call(arguments);
      var prevLocateStrategy = parent.client.locateStrategy;
      var elementCommand = isElementCommand(args);

      if (elementCommand) {
        var firstArg;
        var desiredStrategy;
        var callbackIndex;
        var originalCallback;
        var elementOrSectionName = args.shift();
        var getter = (isChaiAssertion && commandName === 'section') ? getSection : getElement;
        var elementOrSection = getter(parent, elementOrSectionName);
        var ancestors = getAncestorsWithElement(elementOrSection);

        if (ancestors.length === 1) {
          firstArg = elementOrSection.selector;
          desiredStrategy = elementOrSection.locateStrategy;
        } else {
          firstArg = ancestors;
          desiredStrategy = 'recursion';
        }

        setLocateStrategy(parent.client, desiredStrategy);
        args.unshift(firstArg);

        // if a callback is being used with this command, wrap it in
        // a function that allows us to restore the locate strategy
        // to its original value before the callback is called

        callbackIndex = findCallbackIndex(args);
        if (callbackIndex !== -1) {
          originalCallback = args[callbackIndex];

          args[callbackIndex] = function callbackWrapper() {

            // restore the locate strategy directly through client.locateStrategy.
            // setLocateStrategy() can't be used since it uses the api commands
            // which get added to the command queue and will not update the
            // strategy in time for the callback which is getting immediately
            // called after

            parent.client.locateStrategy = prevLocateStrategy;
            return originalCallback.apply(parent.client.api, arguments);
          };
        }
      }

      var c = commandFn.apply(parent.client, args);
      if (elementCommand) {
        setLocateStrategy(parent.client, prevLocateStrategy);
      }
      return (isChaiAssertion ? c : parent);
    };
  }

  /**
   *
   * @param {Array} args
   * @return {boolean}
   */
  function isElementCommand(args) {
    return (args.length > 0) && (args[0].toString().indexOf('@') === 0);
  }

  /**
   * Identifies the location of a callback function within an arguments array.
   *
   * @param {Array} args Arguments array in which to find the location of a callback.
   * @returns {number} Index location of the callback in the args array. If not found, -1 is returned.
   */
  function findCallbackIndex(args) {

    if (args.length === 0) {
      return -1;
    }

    // callbacks will usually be the last argument. waitFor methods allow an additional
    // message argument to follow the callback which will also need to be checked for.

    // last argument

    var index = args.length - 1;
    if (typeof args[index] === 'function') {
      return index;
    }

    // second to last argument (waitfor calls)

    index--;
    if (typeof args[index] === 'function') {
      return index;
    }

    return -1;
  }

  /**
   * Retrieves an array of ancestors of the supplied element. The last element in the array is the element object itself
   *
   * @param {Object} element The element
   * @returns {Array}
   */
  function getAncestorsWithElement(element) {
    var elements = [];
    function addElement(e) {
      elements.unshift(e);
      if (e.parent && e.parent.selector) {
        addElement(e.parent);
      }
    }
    addElement(element);
    return elements;
  }

  /**
   * Adds commands (elements commands, assertions, etc) to the page or section
   *
   * @param {Object} parent The parent page or section
   * @param {Object} target What the command is added to (parent|section or assertion object on parent|section)
   * @param {Object} commands
   * @returns {null}
   */
  function applyCommandsToTarget(parent, target, commands) {

    Object.keys(commands).forEach(function(commandName) {
      if (isValidAssertion(commandName)) {
        target[commandName] = target[commandName] || {};

        var isChaiAssertion = commandName === 'expect';
        var assertions = commands[commandName];

        Object.keys(assertions).forEach(function(assertionName) {
          target[commandName][assertionName] = addCommand(target[commandName], assertions[assertionName], assertionName, parent, isChaiAssertion);
        });
      } else {
        target[commandName] = addCommand(target, commands[commandName], commandName, parent, false);
      }
    });
  }

  function addCommand(target, commandFn, commandName, parent, isChaiAssertion) {
    if (target[commandName]) {
      parent.client.results.errors++;
      var error = new Error('The command "' + commandName + '" is already defined!');
      parent.client.errors.push(error.stack);
      throw error;
    }

    return makeWrappedCommand(parent, commandFn, commandName, isChaiAssertion);
  }

  function isValidAssertion(commandName) {
    return ['assert', 'verify', 'expect'].indexOf(commandName) > -1;
  }

  /**
   * Entrypoint to add commands (elements commands, assertions, etc) to the page or section
   *
   * @param {Object} parent The parent page or section
   * @param {function} commandLoader function that retrieves commands
   * @returns {null}
   */
  this.addWrappedCommands = function (parent, commandLoader) {
    var commands = {};
    commands = commandLoader(commands);
    applyCommandsToTarget(parent, parent, commands);
  };

})();
