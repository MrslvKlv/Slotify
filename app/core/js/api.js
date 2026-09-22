const SYMBOLS = [
    { image: 'img/reels/cat.jpg', name: 'Cat', multiplier: 50 },
    { image: 'img/reels/diamond.jpg', name: 'Diamond', multiplier: 40 },
    { image: 'img/reels/star.jpg', name: 'Star', multiplier: 30 },
    { image: 'img/reels/mask.jpg', name: 'Mask', multiplier: 25 },
    { image: 'img/reels/tent.jpg', name: 'Tent', multiplier: 20 },
    { image: 'img/reels/statue.jpg', name: 'Statue', multiplier: 15 },
    { image: 'img/reels/anubis.jpg', name: 'Scroll', multiplier: 12 },
    { image: 'img/reels/eye.jpg', name: 'Vase', multiplier: 10 },
    { image: 'img/reels/scatter.png', name: 'Crystal', multiplier: 0, isScatter: true },
    { image: 'img/reels/wild.png', name: 'Wild', multiplier: 0, isWild: true }
  ];

  class SlotMachine {
    constructor() {
      this.balance = 1000;
      this.jackpot = 10000;
      this.bet = 10;
      this.paylines = 1;
      this.spinning = false;
      this.autoPlay = false;
      this.sound = true;
      this.reels = [];
      this.positions = [0, 0, 0, 0, 0];
      this.freeSpinsRemaining = 0;
      
      this.initializeGame();
      this.initializeAudio();
      this.bindEvents();
    }

    initializeGame() {
  const reelsContainer = document.getElementById('reels');
  reelsContainer.innerHTML = '';

  for (let i = 0; i < 5; i++) {
    const reel = document.createElement('div');
    reel.className = 'reel';
        
    const reelStrip = document.createElement('div');
    reelStrip.className = 'reel-strip';
        
        const reelSymbols = [];
    for (let j = 0; j < 3; j++) { // symbols coubt
      for (let k = 0; k < SYMBOLS.length; k++) {
        const symbol = document.createElement('div');
        symbol.className = 'symbol';
        const symbolImage = document.createElement('img');
        symbolImage.src = SYMBOLS[k].image;
        symbolImage.alt = SYMBOLS[k].name;
        
        symbol.appendChild(symbolImage);
        reelStrip.appendChild(symbol);
      }
    }

    reel.appendChild(reelStrip);
    reelsContainer.appendChild(reel);
    this.reels.push([...SYMBOLS]); 
  }

      this.updateDisplay();
    }

    initializeAudio() {
      this.sounds = {
        spin: new Audio('audio/spin.wav'),
        win: new Audio('audio/win.wav'),
        click: new Audio('audio/click.wav')
      };
    }

    bindEvents() {
      document.getElementById('addCoinsBtn').onclick = () => this.addCoins();
      document.getElementById('spinButton').onclick = () => this.spin();
      document.getElementById('increaseBet').onclick = () => this.adjustBet(1);
      document.getElementById('decreaseBet').onclick = () => this.adjustBet(-1);
      document.getElementById('autoPlayButton').onclick = () => this.toggleAutoPlay();
      document.getElementById('paylines').onclick = () => this.adjustPaylines();
      document.getElementById('soundToggle').onclick = () => this.toggleSound();
    }

    addCoins() {
      this.balance += 1000;
      this.updateDisplay();
      this.playSound('click');
    }

    async spin() {
  if (this.spinning || (this.balance < this.getTotalBet() && this.freeSpinsRemaining === 0)) return;

  this.spinning = true;
  this.playSound('spin');

  document.getElementById('spinButton').disabled = true;

  if (this.freeSpinsRemaining > 0) {
    this.freeSpinsRemaining--;
    this.updateFreeSpinsDisplay();
  } else {
    this.balance -= this.getTotalBet();
    this.jackpot += this.getTotalBet() * 0.02;
  }

  document.querySelectorAll('.symbol').forEach(symbol => {
    symbol.classList.remove('winning');
  });

  const spinPromises = Array.from({ length: 5 }, (_, i) => this.spinReel(i));
  await Promise.all(spinPromises);

  console.log('Reel positions:', this.positions); // reel pos loction

  const scatterPositions = this.findVisibleScatterPositions();
  const scatterCount = scatterPositions.length;

  if (scatterCount >= 3) {
    this.awardFreeSpins(scatterCount);
    this.highlightScatterSymbols(scatterPositions);
    this.playSound('win');

    const scatterWin = this.calculateScatterWin(scatterCount);
    if (scatterWin > 0) {
      this.showWin(scatterWin);
      this.balance += scatterWin;
    }
  }

  // regular
  const lineWinAmount = this.calculateLineWins(); // notscatter
  if (lineWinAmount > 0) {
    this.showWin(lineWinAmount);
    this.balance += lineWinAmount;
    this.playSound('win');
  }

  this.updateDisplay();
  this.spinning = false;
  document.getElementById('spinButton').disabled = false;

  if ((this.autoPlay && this.balance >= this.getTotalBet()) || this.freeSpinsRemaining > 0) {
    setTimeout(() => this.spin(), 1500);
  }
}

findVisibleScatterPositions() {
  const scatterPositions = [];
  
  for (let reel = 0; reel < this.reels.length; reel++) {
    const symbolIndex = this.positions[reel] % this.reels[reel].length;
    
    // 3 visible positions on each reel (top: 0, middle: 1, bottom: 2)
    for (let visiblePosition = 0; visiblePosition <= 2; visiblePosition++) {
      let checkIndex = (symbolIndex + visiblePosition) % this.reels[reel].length;
      
      if (this.reels[reel][checkIndex].isScatter) {
        scatterPositions.push({
          reel: reel,
          position: visiblePosition,
          symbolIndex: checkIndex
        });
      }
    }
  }

  console.log('Visible Scatter Positions:', scatterPositions); // debug
  return scatterPositions;
}


highlightScatterSymbols(scatterPositions) {
  const reels = document.querySelectorAll('.reel');
  
  scatterPositions.forEach(({ reel, position }) => {
    const reelElement = reels[reel];
    const symbols = reelElement.querySelectorAll('.symbol');
    const middleIndex = Math.floor(symbols.length / 3); 
    const targetIndex = middleIndex + position;
    
    if (symbols[targetIndex]) {
      symbols[targetIndex].classList.add('winning');
      symbols[targetIndex].classList.add('scatter-win');
    }
  });

  setTimeout(() => {
    document.querySelectorAll('.scatter-win').forEach(symbol => {
      symbol.classList.remove('winning', 'scatter-win');
    });
  }, 2000);
}

calculateScatterWin(scatterCount) {
  const scatterMultipliers = {
    3: 5,  
    4: 10, 
    5: 50  
  };
  
  const totalBet = this.getTotalBet();
  return (scatterMultipliers[scatterCount] || 0) * totalBet;
}

calculateLineWins() {
  let totalWin = 0;
  
  for (let line = 0; line < this.paylines; line++) {
    const lineSymbols = [];

    for (let reel = 0; reel < this.reels.length; reel++) {
      const symbolIndex = this.positions[reel] % this.reels[reel].length;
      lineSymbols.push(this.reels[reel][symbolIndex]);
    }

    const lineWin = this.calculateLineWin(lineSymbols);
    totalWin += lineWin;
    
    if (lineWin > 0) {
      this.highlightWinningSymbols(line, lineSymbols);
    }
  }
  
  return totalWin;
}

calculateLineWin(symbols) {class SlotMachine {
constructor() {
  this.reels = []; 
  this.positions = [0, 0, 0, 0, 0]; 
  this.freeSpinsRemaining = 0;
  
  this.initializeGame();
  this.initializeAudio();
  this.bindEvents();
}

findVisibleScatterPositions() {
  const scatterPositions = [];
  
  for (let reel = 0; reel < this.reels.length; reel++) {
    const symbolIndex = this.positions[reel] % this.reels[reel].length;
    
    for (let visiblePosition = 0; visiblePosition <= 2; visiblePosition++) {
      let checkIndex = (symbolIndex + visiblePosition) % this.reels[reel].length;
      
      if (this.reels[reel][checkIndex].isScatter) {
        scatterPositions.push({
          reel: reel,
          position: visiblePosition,
          symbolIndex: checkIndex
        });
      }
    }
  }

  console.log('Visible Scatter Positions:', scatterPositions);
  return scatterPositions;
}

async spin() {
  if (this.spinning || (this.balance < this.getTotalBet() && this.freeSpinsRemaining === 0)) return;

  this.spinning = true;
  this.playSound('spin');

  document.getElementById('spinButton').disabled = true;

  if (this.freeSpinsRemaining > 0) {
    this.freeSpinsRemaining--;
    this.updateFreeSpinsDisplay();
  } else {
    this.balance -= this.getTotalBet();
    this.jackpot += this.getTotalBet() * 0.02;
  }

  document.querySelectorAll('.symbol').forEach(symbol => {
    symbol.classList.remove('winning');
  });

  const spinPromises = Array.from({ length: 5 }, (_, i) => this.spinReel(i));
  await Promise.all(spinPromises);

  console.log('Reel positions:', this.positions);

  const scatterPositions = this.findVisibleScatterPositions();
  const scatterCount = scatterPositions.length;

  if (scatterCount >= 3) {
    this.awardFreeSpins(scatterCount);
    this.highlightScatterSymbols(scatterPositions);
    this.playSound('win');

    const scatterWin = this.calculateScatterWin(scatterCount);
    if (scatterWin > 0) {
      this.showWin(scatterWin);
      this.balance += scatterWin;
    }
  }

  const lineWinAmount = this.calculateLineWins();
  if (lineWinAmount > 0) {
    this.showWin(lineWinAmount);
    this.balance += lineWinAmount;
    this.playSound('win');
  }

  this.updateDisplay();
  this.spinning = false;
  document.getElementById('spinButton').disabled = false;

  if ((this.autoPlay && this.balance >= this.getTotalBet()) || this.freeSpinsRemaining > 0) {
    setTimeout(() => this.spin(), 1500);
  }
}

calculateLineWins() {
  let totalWin = 0;

  for (let line = 0; line < this.paylines; line++) {
    const lineSymbols = [];
    const positions = [];

    for (let reel = 0; reel < this.reels.length; reel++) {
      const symbolIndex = this.positions[reel] % this.reels[reel].length;
      lineSymbols.push(this.reels[reel][symbolIndex]);
      positions.push({ reel: reel + 1, symbolIndex });
    }

    const lineWin = this.calculateLineWin(lineSymbols, positions);
    totalWin += lineWin;

    if (lineWin > 0) {
      this.highlightWinningSymbols(line, lineSymbols);
    }
  }

  return totalWin;
}

calculateLineWin(symbols, positions) {
  let winningSymbol = null;
  let count = 0;
  let wildCount = 0;
  const winPositions = [];

  for (const [i, symbol] of symbols.entries()) {
      console.log(`Checking symbol: ${symbol.name} at index ${i}`);

      if (symbol.isWild) {
          wildCount++;
          winPositions.push(positions[i]);
          console.log(`Wild found at index ${i}. Current wild count: ${wildCount}`);
          continue;
      }

      if (symbol.isScatter) {
          console.log(`Symbol ${symbol.name} is a scatter, stopping count.`);
          break;
      }

      if (!winningSymbol) {
          winningSymbol = symbol;
          count = 1;
          winPositions.push(positions[i]);
      } else if (symbol.name === winningSymbol.name) {
          count++;
          winPositions.push(positions[i]);
      } else {
          break;
      }
  }

  count += wildCount;
  console.log(`Winning Symbol: ${winningSymbol ? winningSymbol.name : 'None'}, Total Count: ${count}`); // Log final count

  if (winningSymbol && count >= 3) {
      this.logWinningCombination(count, winningSymbol.name, winPositions);
      return winningSymbol.multiplier * this.bet * count;
  }

  return 0;
}

logWinningCombination(count, symbolName, positions) {
  let typeOfWin = "";

  switch (count) {
    case 3:
      typeOfWin = "3 of a kind";
      break;
    case 4:
      typeOfWin = "4 of a kind";
      break;
    case 5:
      typeOfWin = "5 of a kind";
      break;
    default:
      typeOfWin = `${count} of a kind`;
  }

  const positionText = positions.map(pos => `Reel ${pos.reel}, Position ${pos.symbolIndex}`).join(", ");
  console.log(`${typeOfWin} - ${symbolName}: ${positionText}`);
}

addStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .scatter-win {
      animation: scatter-pulse 0.5s infinite alternate;
    }
    
    @keyframes scatter-pulse {
      0% { transform: scale(1); }
      100% { transform: scale(1.2); }
    }
  `;
  document.head.appendChild(style);
}
}} 

    spinReel(reelIndex) {
  return new Promise(resolve => {
    const reel = document.querySelectorAll('.reel')[reelIndex];
    const reelStrip = reel.querySelector('.reel-strip');
    
    reelStrip.classList.add('spinning');
    
    const finalPosition = Math.floor(Math.random() * SYMBOLS.length);
    this.positions[reelIndex] = finalPosition;
    
    setTimeout(() => {
      reelStrip.classList.remove('spinning');
      reelStrip.classList.add('stop-spinning');
      
      const symbolHeight = 100;
      const finalOffset = -(finalPosition * symbolHeight);
      reelStrip.style.transform = `translateY(${finalOffset}px)`;
      
      setTimeout(() => {
        reelStrip.classList.remove('stop-spinning');
        resolve();
      }, 500);
    }, 1500 + (reelIndex * 200)); 
  });
}

    countScatterSymbols() {
      let count = 0;
      for (let i = 0; i < this.reels.length; i++) {
        const symbolIndex = this.positions[i] % this.reels[i].length;
        if (this.reels[i][symbolIndex].isScatter) {
          count++;
        }
      }
      return count;
    }

    awardFreeSpins(scatterCount) {
      const freeSpinsMap = {
        3: 10,
        4: 15,
        5: 20
      };
      
      this.freeSpinsRemaining += freeSpinsMap[scatterCount] || 0;
      this.updateFreeSpinsDisplay();
    }

    updateFreeSpinsDisplay() {
      const indicator = document.getElementById('freeSpinsIndicator');
      if (this.freeSpinsRemaining > 0) {
        indicator.style.display = 'block';
        indicator.textContent = `Free Spins Remaining: ${this.freeSpinsRemaining}`;
      } else {
        indicator.style.display = 'none';
      }
    }

    calculateWins() {
      let totalWin = 0;

      for (let line = 0; line < this.paylines; line++) {
        const lineSymbols = [];

        for (let reel = 0; reel < this.reels.length; reel++) {
          const symbolIndex = this.positions[reel] % this.reels[reel].length;
          lineSymbols.push(this.reels[reel][symbolIndex]);
        }
        console.log(`Line ${line + 1} symbols:`, lineSymbols.map(s => s.name));
        const lineWin = this.calculateLineWin(lineSymbols);
        console.log(`Win on Line ${line + 1}: $${lineWin}`);
        totalWin += lineWin;

        if (lineWin > 0) {
          this.highlightWinningSymbols(line, lineSymbols);
        }
      }
      
      return totalWin;
    }

    calculateLineWin(symbols) {
      let winningSymbol = null;
      let count = 0;
      let wildCount = 0;

      for (const symbol of symbols) {
        if (symbol.isWild) {
          wildCount++;
          continue;
        }
        
        if (!winningSymbol && !symbol.isScatter) {
          winningSymbol = symbol;
          count = 1;
        } else if (winningSymbol && symbol.name === winningSymbol.name) {
          count++;
        } else {
          break;
        }
      }
      
      count += wildCount;
      
      if (winningSymbol && count >= 3) {
        return winningSymbol.multiplier * this.bet * count;
      }
      
      return 0;
    }

    highlightWinningSymbols(line, symbols) {
      const reelElements = document.querySelectorAll('.reel');
        symbols.forEach((symbol, index) => {
            const symbolElement = reelElements[index].querySelector('.symbol'); // Ensure you're selecting the correct symbols
            if (symbol.isWild || symbol === symbols[0]) { // Modify this check if needed
                symbolElement.classList.add('winning');
                console.log(`Symbol ${symbol.name} on reel ${index + 1} is a winning symbol`);
                setTimeout(() => symbolElement.classList.remove('winning'), 2000);
            }
      });
    }

    showWin(amount) {
      const overlay = document.getElementById('winOverlay');
      const winAmount = document.getElementById('winAmount');
      
      winAmount.textContent = amount;
      overlay.style.display = 'flex';
      
      setTimeout(() => {
        overlay.style.display = 'none';
      }, 3000);
    }

    getTotalBet() {
      return this.bet * this.paylines;
    }

    adjustBet(change) {
      const newBet = Math.max(1, Math.min(100, this.bet + change));
      if (newBet !== this.bet) {
        this.bet = newBet;
        this.updateDisplay();
        this.playSound('click');
      }
    }

    adjustPaylines() {
      this.paylines = this.paylines === 1 ? 3 : this.paylines === 3 ? 5 : 1;
      document.getElementById('paylines').textContent = `Lines: ${this.paylines}`;
      this.updateDisplay();
      this.playSound('click');
    }

    toggleAutoPlay() {
      this.autoPlay = !this.autoPlay;
      const button = document.getElementById('autoPlayButton');
      button.textContent = this.autoPlay ? 'Stop Auto' : 'Auto Play';
      if (this.autoPlay && !this.spinning) {
        this.spin();
      }
    }

    toggleSound() {
      this.sound = !this.sound;
      const button = document.getElementById('soundToggle');
      button.textContent = this.sound ? '🔊' : '🔇';
    }

    playSound(soundName) {
      if (this.sound && this.sounds[soundName]) {
        this.sounds[soundName].currentTime = 0;
        this.sounds[soundName].play().catch(() => {});
      }
    }

    updateDisplay() {
      document.getElementById('balanceAmount').textContent = this.balance;
      document.getElementById('jackpotAmount').textContent = Math.floor(this.jackpot);
      document.getElementById('betAmount').textContent = `Bet: $${this.getTotalBet()}`;
      
      const canSpin = this.balance >= this.getTotalBet() || this.freeSpinsRemaining > 0;
      document.getElementById('spinButton').disabled = this.spinning || !canSpin;
    }
  }
  window.onload = () => {
    const game = new SlotMachine();
  };