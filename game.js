router.post('/coin-flip', isAuth, async (req, res) => {
  const { amount, selection } = req.body;
  const userId = req.session.user.id;
  const betAmount = parseInt(amount);

  if (isNaN(betAmount) || betAmount <= 0) 
    return res.status(400).json({ success: false, message: 'সঠিক পরিমাণ দিন' });

  let winAmount = 0;
  const result = Math.random() < 0.5 ? 'head' : 'tail';

  if (selection === result) winAmount = betAmount * 2;

  // ডেটাবেস আপডেটের লজিক এখানে যুক্ত করুন

  res.json({ success: true, result, winAmount });
});
